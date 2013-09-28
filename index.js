var CachingProxy = exports.CachingProxy = require("./lib/caching-proxy.js");

/**
 * Gets connect middleware callback
 *
 * @param options
 * @param cache
 * @returns {Function}
 */
exports.createProxy = function(options, cache){
    var cachingProxy = new CachingProxy(options);
    cachingProxy.setCache(cache);
    return function(req, res, next) {
        cachingProxy.serverHandler(req, res);
    }
}

/**
 * Expose included backends
 *
 * @type {{mongodb: Function}}
 */
exports.backends = {
    mongodb: require("./lib/storage/mongodb.js").CacheStorage
};
