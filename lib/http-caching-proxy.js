var httpProxy = require('http-proxy');

var ProxyRequest = exports.ProxyRequest = function(req, res) { this.init(req, res); };
ProxyRequest.count = 0;
ProxyRequest.prototype = {

  init: function(req, res) {
    req.proxyRequest = this;
    this.request = req;
    this.response = res;
    this.protocol = req.isSpdy ? 'https' : (req.connection.pair ? 'https' : 'http');
    this.proxyBuffer = httpProxy.buffer(req);
    this.cacheKey = this.protocol+'://'+req.headers.host+req.url;
    this.chunkCache = [];
    ProxyRequest.count++;
  },

  destroy: function() {
    this.request.proxyRequest = null;
    this.request = this.response = this.proxyBuffer = this.chunkCache = null;
  }

};

var CachingProxy = exports.CachingProxy = function(config){ this.init(config); };
CachingProxy.prototype = {

  cache: null,
  cacheStatus: null,

  init: function(config) {
    this.config = config;
    this.server = httpProxy.createServer(this.serverHandler.bind(this));
    this.proxy = this.server.proxy;
    this.proxy.on('data', function(chunk, req) {
      req.proxyRequest.chunkCache.push(chunk);
    });
    this.proxy.on('end', this.proxyComplete.bind(this));
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

  serverHandler: function (req, res) {
    var proxyRequest = new ProxyRequest(req, res);
    console.log(req.method+': '+proxyRequest.cacheKey);
    if (req.method == 'GET' && this.getCache()) {
      this.checkCache(proxyRequest);
    } else {
      this.cacheMiss(proxyRequest);
    }
  },

  proxyComplete: function(req, res, upstreamResponse) {
    var proxyRequest = req.proxyRequest;
    console.log('Proxied request: '+proxyRequest.cacheKey+' ('+upstreamResponse.statusCode+')');
    if (req.method == 'GET') {
      var lifetime = this.getCacheLifetime(upstreamResponse);
      if (lifetime && this.getCache()) {
        this.storeResponse(proxyRequest, upstreamResponse, lifetime);
      }
    }
    proxyRequest.destroy();
  },

  getCacheLifetime: function(response) {
    // TODO - return time to cache response for
    return false;
  },

  storeResponse: function(proxyRequest, upstreamResponse, lifetime) {
    var headers = upstreamResponse.headers;
    // TODO - filter headers (or only before serving?)
    var data = {
      key: proxyRequest.cacheKey,
      headers: headers,
      body: proxyRequest.chunkCache.join('')
    };
    if (headers['etag']) {
      data.etag = headers['etag'];
    }
    if (headers['last-modified']) {
      data.lm = headers['last-modified'];
    }
    // TODO - set data.fresh for quick computation of freshness?
    this.cache.set(data, lifetime, function(err) {
      if (err) {
        console.log('Error saving to cache: '+err);
      }
    });
  },

  checkCache: function(proxyRequest) {
    this.cache.search(proxyRequest.cacheKey, 10, this.checkCacheResult.bind(this, proxyRequest));
  },

  checkCacheResult: function(proxyRequest, err, docs) {
    console.log('Cache candidates result: '+docs.length);
    if (err || ! docs.length) {
      this.cacheMiss(proxyRequest);
    } else {
      var etags = [], lm = false;
      var fresh = docs.some(function(doc){
        if (0 /* doc does not need revalidation */) {
          return true;
        }
        if (doc.etag) {
          etags.push(doc.etag);
        }
        if (doc.lm) {
          lm = lm === false || doc.lm > lm ? doc.lm : lm;
        }
        return false;
      }, this);
      if (fresh) {
        // TODO - send cached response with no revalidation
      }
      else if (etags.length || lm) {
        // TODO - revalidate request
      }
      else {
        this.cacheMiss(proxyRequest);
      }
    }
  },

  cacheMiss: function(proxyRequest) {
    console.log('Cache MISS: '+proxyRequest.cacheKey);
    this.proxy.proxyRequest(proxyRequest.request, proxyRequest.response, {
      host: this.config.upstream[0],
      port: this.config.upstream[1],
      buffer: proxyRequest.proxyBuffer
    });
  }

};
