var mongodb = require('mongodb');
//noinspection JSUnresolvedVariable
var _ = require('lodash')._;

var CacheStorage = exports.CacheStorage = function(config){ this.init(config); };
CacheStorage.prototype = {

  collection: null,

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
	    this.collection = new mongodb.Collection(client, 'httpcache');
      // TODO - ensure indexes
      this.collectGarbage();
	  }
	  callback(error);
	}.bind(this));
  },

  search: function(key, limit, callback) {
    this.collection.find({key: key, eol: {$gte: new Date()}}, {etag:1, lm:1}).limit(10).toArray(callback);
  },

  get: function(doc, callback) {
    this.collection.find({_id: doc._id}).toArray(function(err, docs) {
      if ( ! err && ! docs.length) err = 'Record went away?';
      var doc = err ? null : docs.shift();
      callback(err, doc);
    });
  },

  set: function(data, lifetime, callback) {
    data.eol = new Date();
    data.eol.setSeconds(data.expires.getSeconds() + lifetime);
    this.collection.insert(data, {safe: false}, function(err, result){
      callback(err);
    });
  },

  remove: function(key, etag, callback) {
    var query = {
      key: key,
      etag: etag || {$eq:''}
    };
    this.collection.remove(query, callback || function(){});
  },

  removeAll: function(docs, callback) {
    var ids = _.pluck(docs, '_id');
    this.collection.remove({_id: {$in: ids}}, callback || function(){});
  },

  collectGarbage: function() {
    this.collection.remove({eol: {$lt: new Date()}}, this.gcCallback);
  }

};
