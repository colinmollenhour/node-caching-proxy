var mongodb = require('mongodb');

var CacheStorage = exports.CacheStorage = function(config){ this.init(config); };
CacheStorage.prototype = {
  collection: null,
  init: function(config) {
    this.config = config;
    this.mongo = new mongodb.Server(config.server, config.port, config.options);
    this.db = new mongodb.Db(config.db, this.mongo, {safe: false});
  },
  connect: function(callback) {
    this.db.open(function(error, client) {
	  if ( ! error) {
	    this.collection = new mongodb.Collection(client, 'httpcache');
	  }
	  callback(error);
	}.bind(this));
  },
  search: function(key, limit, callback) {
    this.collection.find({key: key}, {limit:10}).toArray(callback);
  },
  get: function(id, callback) {
  },
  set: function(key, etag, callback) {
  },
  remove: function(key, etag, callback) {
  }
};
