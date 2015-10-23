/*
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/.
 */

/*
 * Copyright (c) 2015, Joyent, Inc.
 */

var mod_assert = require('assert');
var mod_assertplus = require('assert');
var mod_bunyan = require('bunyan');
var mod_eventemitter = require('events').EventEmitter;
var mod_libuuid = require('node-libuuid');
var mod_moray = require('moray');
var mod_util = require('util');
var mod_vasync = require('vasync');
var mod_watershed = require('watershed').Watershed;

var shed = new mod_watershed();
var pollTime = 2000; // Poll moray bucket every 2 seconds

/*
 * Publisher module constructor that takes an options object.
 *
 * Example options object:
 * var options = {
 *    log: new Bunyan({
 *       name: 'publisher_test',
 *       level: process.env['LOG_LEVEL'] || 'trace',
 *       stream: process.stderr
 *    }),
 *   morayBucketName: 'change_feed_bucket',
 *   morayHost: '10.99.99.17',
 *   morayResolvers: {
 *       resolvers: ['10.99.99.11']
 *   },
 *   morayTimeout: 200,
 *   morayMinTimeout: 1000,
 *   morayMaxTimeout: 2000,
 *   morayPort: 2020,
 *   restifyServer: server,
 *   resources: resources
 * };
 */
function Publisher(options) {
    var self = this;
    self.pollInterval = null;
    mod_eventemitter.call(self);

    // registrations and websockets track listener details, and are used for GC.
    self.registrations = {};
    self.websockets = {};

    self.morayHost = options.morayHost;
    self.morayResovlers = options.morayResolvers;
    self.morayTimeout = options.morayTimeout;
    self.morayMinTimeout = options.morayMinTimeout;
    self.morayMaxTimeout = options.morayMaxTimeout;
    self.morayPort = options.morayPort;
    self.morayBucket = {
        name: options.morayBucketName,
        config: {
            index: {
                published: { type: 'string' }
            }
        }
    };

    self.resources = options.resources;

    var log = this.log = options.log;
    var morayClient = this.morayClient = mod_moray.createClient({
        dns: this.morayResolvers,
        connectTimeout: this.morayTimeout || 200,
        log: this.log,
        host: this.morayHost,
        port: this.morayPort,
        reconnect: false,
        retry: {
            retries: Infinity,
            minTimeout: this.morayMinTimeout || 1000,
            maxTimeout: this.morayMaxTimeout || 16000
        }
    });

    morayClient.on('connect', function _morayConnect() {
        log.info({ moray: morayClient.toString() }, 'moray: connected');
        self.emit('moray-connected');

        morayClient.on('error', function _morayError(err) {
            log.error(err, 'moray client error');
        });
        // Auto setup the change feed moray bucket
        self._setupBucket(function _bucketSetupError(err) {
            if (err) {
                log.error({ err: err }, 'Bucket was not loaded');
            } else {
                log.info('Bucket successfully loaded');
                self.emit('moray-ready');
            }
        });
    });

    var server = options.restifyServer;
    server.get('/change-feeds', self._getResources.bind(this));
    server.get('/change-feeds/stats', self._getStats.bind(this));
    server.on('upgrade', function _upgrade(req, socket, head) {
        var websocket = null;
        log.info('websocket upgrade taking place');
        try {
            websocket = shed.accept(req, socket, head);
        } catch (ex) {
            log.error('error: ' + ex.message);
            return socket.end();
        }

        // The use of once is deliberate. This should accept no data from the
        // listener after bootstrap.
        websocket.once('text', function _register(text) {
            var registration = JSON.parse(text);
            self.websockets[registration.instance] = websocket;
            self.registrations[registration.instance] = registration;
            var response = null;
            for (var i = 0; i < self.resources.length; i++) {
                var resource = self.resources[i];
                if (resource.resource === registration.changeKind.resource) {
                    log.info('Accepting valid registration response');
                    response = resource;
                }
            }
            // If the registration was valid, send the bootstrap response
            if (response) {
                websocket.send(JSON.stringify(response));
            } else {
                var regResource = registration.changeKind.resource;
                log.warn('Invalid registration resource: %s', regResource);
            }
        });

        // When a listener disconnects, for any reason, clean up listeners
        websocket.on('end', function _end() {
            for (var instance in self.registrations) {
                if (this._id === self.websockets[instance]._id) {
                    log.info('Collecting instance: %s', instance);
                    delete self.websockets[instance];
                    delete self.registrations[instance];
                }
            }
        });
        websocket.on('connectionReset', function _connectionReset() {
            for (var instance in self.registrations) {
                if (this._id === self.websockets[instance]._id) {
                    log.info('Collecting instance: %s', instance);
                    delete self.websockets[instance];
                    delete self.registrations[instance];
                }
            }
        });

        return null;
    });
}

mod_util.inherits(Publisher, mod_eventemitter);

/*
 * Halts all publishing operations including Moray polling and WebSocket push
 */
Publisher.prototype.stop = function stop() {
    var self = this;
    clearInterval(self.pollInterval);
    self.morayClient.close();
};

/*
 * This causes the publisher module to begin polling its moray bucket and push
 * change feed events to registered listeners. Items in the moray bucket are
 * initially marked with `published=no`, and subsequently updated with a
 * published value of date when they were sent to listeners.
 */
Publisher.prototype.start = function start() {
    var self = this;
    var client = self.morayClient;
    var bucketName = self.morayBucket.name;
    var log = self.log;
    self.pollInterval = setInterval(function _poll() {
        var req = client.findObjects(bucketName, '(published=no)');
        req.on('error', function _reqErr(err) {
            log.warn(err);
        });

        req.on('record', function _record(record) {
            log.info(record);
            var value = record.value;
            value.published = Date.now().toString();
            var strValue = null;
            try {
                strValue = JSON.stringify(value);
            } catch (ex) {
                log.error('Error serializing value: %s', ex.message);
            }

            // The double for loop is not the most efficent choice, however
            // in practice it shouldn't see enough iterations to matter at this
            // point. The simplicity out weighs the complexity of implementing
            // a more sophisticated structure at this point.
            for (var instance in self.registrations) {
                var regWebsocket = self.websockets[instance];
                var regChangeKind = self.registrations[instance].changeKind;
                var resource = value.changeKind.resource;
                if (regChangeKind.resource === resource) {
                    var regSubResources = regChangeKind.subResources;
                    var subResources = value.changeKind.subResources;
                    for (var i = 0; i < subResources.length; i++) {
                        if (regSubResources.indexOf(subResources[i]) !== -1) {
                            regWebsocket.send(strValue);
                            log.info('Published: %s', strValue);
                            self.emit('item-published');
                            break;
                        }
                    }
                } else {
                    log.info('No registrations for value: %j', value);
                }
            }

            // Mark each change feed item as published so that they aren't
            // re-sent to registered listeners.
            client.putObject(bucketName, record.key, value, function _mark() {
                log.info('marking %s published', record.key);
            });
        });

        req.on('end', function _noItems() {
            self.emit('no-items');
            log.info('findObjects ended');
        });
    }, pollTime);
};

/*
 * Add item to change feed Moray bucket so that it can be picked up and fully
 * published by the polling mechanism in start().
 */
Publisher.prototype.publish = function publish(item, cb) {
    this._putObject(item, function (err) {
        cb(err);
    });
};

Publisher.prototype._createBucket = function _createBucket(cb) {
    var bucket = this.morayBucket;
    this.morayClient.createBucket(bucket.name, bucket.config, cb);
};

Publisher.prototype._getBucket = function _getBucket(cb) {
    this.morayClient.getBucket(this.morayBucket.name, cb);
};

Publisher.prototype._getStats = function _getStats(req, res, next) {
    var listenerCount = 0;
    var listenerRegistrations = null;
    if (this.registrations) {
        listenerCount = Object.keys(this.registrations).length;
        listenerRegistrations = this.registrations;
    }

    var stats = {
        listeners: listenerCount,
        registrations: listenerRegistrations
    };
    res.send(stats);
    next();
};

Publisher.prototype._getResources = function _getResources(req, res, next) {
    res.send(this.resources);
    next();
};

Publisher.prototype._putObject = function _putObject(item, cb) {
    var bucket = this.morayBucket;
    this.morayClient.putObject(bucket.name, mod_libuuid.v4(), item, cb);
};

Publisher.prototype._setupBucket = function _setupBucket(cb) {
    var self = this;
    self._getBucket(function _getBucketError(err) {
        if (err) {
            if (err.name === 'BucketNotFoundError') {
                self._createBucket(cb);
            } else {
                return cb(err);
            }
        }

        return cb(err);
    });
};

module.exports = Publisher;