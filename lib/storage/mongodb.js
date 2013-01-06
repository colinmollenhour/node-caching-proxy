var crypto = require('crypto');
var mongodb = require('mongodb');
//noinspection JSUnresolvedVariable
var _ = require('lodash')._;

/*
 * Schema:
 *
 * httpindex: {
 *   _id: String(uri),
 *   selecting: [],
 *   last: Date, // TTL
 *   requests: int,
 *   hits: int
 * }
 *
 * httpresponses: {
 *   _id: MongoId,
 *   key: String(cacheKey),
 *   eol: Date, // TTL
 *   status: int,
 *   headers: {},
 *   body: String,
 *   etag: String,
 *   lm: Date,
 *   exp: Date,
 *   mr: bool,
 *   hits: int,
 *   updates: int
 * }
 */

var CacheStorage = exports.CacheStorage = function(config){ this.init(config); };
CacheStorage.prototype = {

  index: null,
  responses: null,

  init: function(config) {
    this.config = config;
    this.mongo = new mongodb.Server(config.server, config.port, config.options);
    this.db = new mongodb.Db(config.db, this.mongo, {safe: false});

    var gcHandler = this.collectGarbage.bind(this), gcDelay = this.config.gc_frequency || 300000;
    this.gcCallback = function() { setTimeout(gcHandler, gcDelay); };
  },

  connect: function(callback) {
    this.db.open(function(error, client) {
      if ( ! error) {
        this.index = new mongodb.Collection(client, 'httpindex');
        this.responses = new mongodb.Collection(client, 'httpresponses');
        this.initIndexes(function(err) { if (err) console.log('Error initializing indexes: '+err); });
        this.collectGarbage();
      }
      callback(error);
    }.bind(this));
  },

  initIndexes: function(callback) {
    this.index.ensureIndex({last: 1}, {expireAfterSeconds: 60, w: 1}, callback);
    this.responses.ensureIndex({key: 1}, {w: 1}, callback);
    this.responses.ensureIndex({eol: 1}, {expireAfterSeconds: 60, w: 1}, callback);
  },

  getKey: function(uri, vary) {
    var key = uri+'|'+vary;
    if (key.length > 64) {
      key = crypto.createHash('sha1').update(key).digest('hex');
    }
    return key;
  },

  updateIndex: function(uri, data) {
    data.last = new Date();
    this.index.update(
      {_id: uri},
      {$set: data},
      {upsert: true}
    );
  },

  lookup: function(uri, callback) {
    this.index.findOne({_id: uri}, {requests: 0, hits: 0, last: 0}, function(err, doc) {
      callback(err, doc);
      if ( ! err && doc) {
        this.index.update({_id: doc._id}, {$inc: {requests:1}}, {w: 0});
      }
    }.bind(this));
  },

  fetchMeta: function(key, limit, callback) {
    this.responses.find(
      {key: key, eol: {$gte: new Date()}},
      {eol:0, headers:0, body:0, hits:0},
      {hint: {key:1}}
    ).limit(10).toArray(callback);
  },

  getResponse: function(doc, callback) {
    this.responses.findOne({_id: doc._id}, function(err, doc) {
      if ( ! err && ! doc) err = 'Record went away?';
      callback(err, doc);
      if ( ! err) {
        this.responses.update({_id: doc._id}, {$inc: {hits:1}}, {w: 0});
      }
    }.bind(this));
  },

  storeResponse: function(key, data, lifetime, replace, callback) {
    data.key = key;
    data.eol = new Date();
    data.eol.setSeconds(data.exp.getSeconds() + lifetime);
    if ( ! data.lm) _.omit(data, 'lm');
    var cb = function(err, result){ callback(err); };
    if (replace) {
      this.responses.update(
        {key: data.key},
        {$set: data, $inc: {updates: 1}},
        {upsert:true, w:1},
        cb
      );
    } else {
      this.responses.insert(data, {w: 1}, cb);
    }
  },

  remove: function(key, etag, callback) {
    var query = {
      key: key,
      etag: etag || {$eq:''}
    };
    this.responses.remove(query, callback || function(){});
  },

  removeAll: function(docs, callback) {
    var ids = _.pluck(docs, '_id');
    this.responses.remove({_id: {$in: ids}}, callback || function(){});
  },

  logHit: function(uri) {
    this.index.update({_id: uri}, {$inc: {hits:1}}, {w: 0});
  },

  collectGarbage: function() {
    // noop - MongoDb 2.2 required for TTL index support
  }

};
