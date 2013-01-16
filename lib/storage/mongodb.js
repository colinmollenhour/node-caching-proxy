var mongodb        = require('mongodb')
   ,crypto         = require('crypto')
   ,_              = require('lodash')._
;

/*
 * Schema:
 *
 * httpindex: {
 *   _id: String(uri),
 *   selecting: [],
 *   eol: Date, // TTL
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
 *   sr: bool,
 *   mr: bool,
 *   hits: int,
 *   updates: int
 * }
 */

var CacheStorage = exports.CacheStorage = function(config){ this.init(config); };
CacheStorage.prototype = {

  db: null,
  index: null,
  responses: null,

  init: function(config) {
    this.config = _.extend({
      server: 'mongodb://127.0.0.1:27017/proxy_cache'
    }, config || {});
  },

  connect: function(callback) {
    mongodb.MongoClient.connect(this.config.server, {server: {auto_reconnect: true}}, function(error, db) {
      if ( ! error) {
        this.db = db;
        this.index = this.db.collection('httpindex');
        this.responses = this.db.collection('httpresponses');
        this.initIndexes(function(err) { if (err) console.log('Error initializing indexes: '+err); });
      }
      callback(error);
    }.bind(this));
  },

  initIndexes: function(callback) {
    var a, b, c, cb = function(){ if (!_.isUndefined(a)&&!_.isUndefined(b)&&!_.isUndefined(c)) callback(a||b||c); }
    this.index.ensureIndex({eol: 1}, {expireAfterSeconds: 86400, w: 1}, function(err){a=err; cb();});
    this.responses.ensureIndex({key: 1, etag: 1}, {unique: 1, w: 1},     function(err){b=err; cb();});
    this.responses.ensureIndex({eol: 1}, {expireAfterSeconds: 60, w: 1}, function(err){c=err; cb();});
  },

  getKey: function(uri, vary) {
    var key = uri+'|'+vary;
    if (key.length > 64) {
      key = crypto.createHash('sha1').update(key).digest('hex');
    }
    return key;
  },

  updateIndex: function(uri, data) {
    if ( ! data.eol) data.eol = new Date();
    this.index.update(
      {_id: uri},
      {$set: data},
      {upsert: true, w: 1},
      function(err) { if(err) console.log(err); }
    );
  },

  lookup: function(uri, callback) {
    this.index.findOne({_id: uri}, {requests: 0, hits: 0, eol: 0}, function(err, doc) {
      if (err) console.log(err);
      callback(doc);
      if ( ! err && doc) {
        this.index.update({_id: doc._id}, {$inc: {requests:1}}, {w: 0});
      }
    }.bind(this));
  },

  fetchMeta: function(key, limit, callback) {
    this.responses.find(
      {key: key, eol: {$gte: new Date()}},
      {eol:0, headers:0, body:0, hits:0},
      {hint: {key:1, etag:1}}
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

  storeResponse: function(key, data, lifetime, callback) {
    data.key = key;
    data.eol = new Date(data.exp.getTime() + (lifetime * 1000)); // Cache lifetime is freshness expiration + lifetime
    if ( ! data.lm) _.omit(data, 'lm');
    var cb = function(err, result){ if (err) throw err; callback(err); };
    this.responses.update(
      {key: data.key, etag: data.etag},
      {$set: data, $inc: {updates: 1}},
      {upsert:true, w:1},
      cb
    );
  },

  remove: function(key, etag, callback) {
    this.responses.remove({
      key: key,
      etag: etag || {$eq:''}
    }, callback || function(){});
  },

  removeAll: function(docs, callback) {
    var ids = _.pluck(docs, '_id');
    this.responses.remove({_id: {$in: ids}}, callback || function(){});
  },

  logHit: function(uri) {
    this.index.update({_id: uri}, {$inc: {hits:1}}, {w: 0});
  }

};
