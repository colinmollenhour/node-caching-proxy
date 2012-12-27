var httpProxy = require('http-proxy');

var ProxyRequest = exports.ProxyRequest = function(req, res, proxy) { this.init(req, res, proxy); };
ProxyRequest.prototype = {
  init: function(req, res, proxy) {
    this.request = req;
    this.response = res;
    this.proxy = proxy;
    this.proxyBuffer = httpProxy.buffer(req);
  this.cacheKey = req.headers.host+req.url;
  }
};

var CachingProxy = exports.CachingProxy = function(config){ this.init(config); };
CachingProxy.prototype = {
  cache: null,
  cacheStatus: null,
  init: function(config) {
    this.config = config;
    this.server = httpProxy.createServer(this.serverHandler.bind(this));
    this.server.proxy.on('end', function(req, res) {
      console.log('Proxied request: '+req.url);
    });
  },
  start: function() {
    this.server.listen(this.config.port);
    return this;
  },
  setCache: function(cache) {
    this.cache = cache;
    return this;
  },
  getCache: function() {
    console.log('Cache status: '+this.cacheStatus);
    if ( ! this.cache) {
      return false;
    }
    if (this.cacheStatus == 'connected') {
      return this.cache;
    }
    if (this.cacheStatus == 'connecting') {
      return false;
    }
    if (this.cacheStatus == 'error') {
      setTimeout(function(){ this.cacheStatus = null; }.bind(this), 1000);
      return false;
    }
    this.cacheStatus = 'connecting';
    this.cache.connect(this.cacheConnectCallback.bind(this));
    return false;
  },
  cacheConnectCallback: function (error) {
    if (error) {
      this.cacheStatus = 'error';
      throw error;
    }
    this.cacheStatus = 'connected';
  },
  serverHandler: function (req, res, proxy) {
    var proxyRequest = new ProxyRequest(req, res, proxy);
    console.log('New request received: '+proxyRequest.cacheKey);
    if (this.getCache()) {
      this.checkCache(proxyRequest);
    } else {
      this.cacheMiss(proxyRequest);
    }
  },
  checkCache: function(proxyRequest) {
    this.cache.search(proxyRequest.cacheKey, 10, this.checkCacheResult.bind(this, proxyRequest));
  },
  checkCacheResult: function(proxyRequest, err, docs) {
    if (err || ! docs.length) {
      this.cacheMiss(proxyRequest);
    } else {
      console.log('Cache HIT: '+docs.length);
      // TODO - process possible hits
    }
  },
  cacheMiss: function(proxyRequest) {
    if ( ! proxyRequest) {
      console.log('WAT!');
    }
    proxyRequest.proxy.proxyRequest(proxyRequest.request, proxyRequest.response, {
      host: this.config.upstream[0],
      port: this.config.upstream[1],
      buffer: proxyRequest.proxyBuffer
    });
  // TODO - observe and save
  }
};
