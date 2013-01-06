var crypto = require('crypto');
var mongodb = require('mongodb');
//noinspection JSUnresolvedVariable
var _ = require('lodash')._;

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
        // TODO - ensure indexes
        this.collectGarbage();
      }
      callback(error);
    }.bind(this));
  },

  getKey: function(uri, vary) {
    var key = uri+'|'+vary;
    if (key.length > 64) {
      key = crypto.createHash('sha1').update(key).digest('hex');
    }
    return key;
  },

  updateIndex: function(uri, selecting) {
    this.index.update({_id: uri}, {selecting: selecting}, {upsert: true});
  },

  lookup: function(uri, callback) {
    this.index.findOne({_id: uri}, callback);
  },

  fetchMeta: function(key, limit, callback) {
    this.responses.find({key: key, eol: {$gte: new Date()}}, {etag:1, lm:1}).limit(10).toArray(callback);
  },

  getResponse: function(doc, callback) {
    this.responses.findOne({_id: doc._id}, function(err, doc) {
      if ( ! err && ! doc) err = 'Record went away?';
      callback(err, doc);
    });
  },

  storeResponse: function(key, data, lifetime, replace, callback) {
    data.key = key;
    data.eol = new Date();
    data.eol.setSeconds(data.expires.getSeconds() + lifetime);
    var cb = function(err, result){ callback(err); };
    if (replace) {
      this.responses.update({key: data.key}, data, {w: 1, upsert: true}, cb);
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

  collectGarbage: function() {
    var removeDate = new Date();
    removeDate.setSeconds(removeDate.getSeconds() - 60);  // Allow revalidate requests to complete
    this.responses.remove({eol: {$lt: removeDate}}, this.gcCallback);
    // TODO - gc the index
  }

};
