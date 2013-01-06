var httpProxy = require('http-proxy');
//noinspection JSUnresolvedVariable
var _ = require('lodash')._;

var ProxyRequest = exports.ProxyRequest = function(req, res) { this.init(req, res); };
ProxyRequest.count = 0;
ProxyRequest.prototype = {

  init: function(req, res) {
    req.proxyRequest = this;
    this.uri = this.protocol+'://'+req.headers.host+req.url;
    this.request = req;
    this.response = res;
    this.protocol = req.isSpdy ? 'https' : (req.connection.pair ? 'https' : 'http');
    this.proxyBuffer = httpProxy.buffer(req);
    this.cacheKey = null;
    this.chunkCache = []; // collect response body for proxied or revalidate requests
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
  defaultExpiration: 3600,

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
    this.cache.connect(function (error) {
      if (error) {
        this.cacheStatus = 'error';
        throw error;
      }
      this.cacheStatus = 'connected';
    }.bind(this));
    return false;
  },

  serverHandler: function (req, res) {
    var proxyRequest = new ProxyRequest(req, res);
    console.log(req.method+': '+proxyRequest.uri);
    if (this.getCache() && this.canUseCache(req)) {
      this.checkCache(proxyRequest);
    } else {
      this.cacheMiss(proxyRequest);
    }
  },

  proxyComplete: function(req, res, upstreamResponse) {
    var proxyRequest = req.proxyRequest;
    console.log('Proxied request: '+proxyRequest.uri+' ('+upstreamResponse.statusCode+')');
    if (req.method == 'GET') {
      switch (upstreamResponse.statusCode) {
        case 200:
        case 301:
        case 404:
          this.storeResponse(proxyRequest, upstreamResponse);
          break;
        default:
          break;
      }
    }
    proxyRequest.destroy();
  },

  storeResponse: function(proxyRequest, upstreamResponse) {
    if ( ! this.getCache())  return;

    var now = Math.ceil((new Date()).getTime()/1000);
    var headers = upstreamResponse.headers;

    // Get cache-control directives
    var expires = _.has(headers, 'expires') ? headers['expires'] : false;
    if ( ! expires && ! _.has(headers, 'cache-control') && ! _.has(headers, 'x-accel-cache-control'))  return;

    var cacheControlStr = headers['cache-control'] || headers['x-accel-cache-control'] || '';
    var cacheControl = cacheControlStr.split(/\s*;\s*/);
    if (_.contains(cacheControl, 'no-cache') || _.contains(cacheControl, 'no-store'))  return;

    var maxage = (cacheControlStr.match(/max-age=(\d+)/) || [,false])[1];
    var smaxage = (cacheControlStr.match(/s-maxage=(\d+)/) || [,false])[1];
    var policy = _.find(cacheControl, function(tok){ return _.contains(['public', 'private'], tok); });
    var vary = headers['vary'];
    var revalidate = vary == '*' || null != cacheControlStr.match(/(must|proxy)-revalidate/);

    if ( ! policy && (maxage !== false || smaxage !== false || expires !== false)) {
      policy = 'public';
    }
    if ( ! policy)  return;

    // Get cache record freshness expiration
    var expiration = new Date();
    if (smaxage !== false) {
      expiration.setSeconds(expiration.getSeconds() + smaxage);
      revalidate = true; // s-maxage implies proxy-revalidate
    } else if (maxage !== false) {
      expiration.setSeconds(expiration.getSeconds() + maxage);
    } else if (expires) {
      var expDate = Date.parse(expires) || now;
      var date = _.has(headers, 'date') ? Date.parse(headers['date']) : now;
      var expSeconds = Math.round((expDate - date) / 1000);
      if (expSeconds >= 0) {
        expiration.setSeconds(expiration.getSeconds() + expSeconds);
      } else if (cacheControl) {
        expiration = now;
      } else {
        return;
      }
    } else {
      expiration.setSeconds(expiration.getSeconds() + this.defaultExpiration);
    }

    // Get cache record lifetime
    var lifetime, result;
    if (result = (headers['cache-control'] || '').match(/lifetime=(\d+)/)) {
      lifetime = result[1];
    } else if (result = (headers['x-accel-expires'] || '').match(/^(off|\d+)$/)) {
      if (result[1] == 'off') {
        return;
      }
      lifetime = result[1];
    } else {
      lifetime = 3600; // Default - TODO
    }

    // Get sorted Vary values for later updating uri index
    var selecting = ! vary || vary == '*' ? [] : vary.toLowerCase().split(/, ?/).sort();

    // Cloak headers from upstream responses
    var toCloak = (headers['x-accel-cloak'] || '').toLowerCase().split(/, ?/);
    headers = _.pick(headers, function(value, key){
      return ! key.match(/^x-accel/) && !_.contains(toCloak, key);
    });

    // Update index and store response
    var uriData = {
      selecting: selecting
    };
    var responseData = {
      headers: headers,
      body: proxyRequest.chunkCache.join(''),
      etag: headers['etag'] || '',
      lm: headers['last-modified'] ? Date.parse(headers['last-modified']) : false,
      exp: expiration,
      mr: revalidate
    };
    var replace = ! vary || vary == '*';
    this.cache.storeResponse(proxyRequest.cacheKey, responseData, lifetime, replace, function(err) {
      if (err)  console.log('Error saving to cache: '+err);
      else      this.cache.updateIndex(proxyRequest.uri, uriData); // Update uri index after record so there are no false hits
    }.bind(this));
  },

  canUseCache: function(request) {
    if (request.method != 'GET')  return false;
    // TODO - allow disabling user agent use of no-cache and max-age
    if ((request.headers['cache-control'] || '').match(/no-cache/)) return false;
    if ((request.headers['cache-control'] || '').match(/max-age=0/)) return false;
    return true;
  },

  checkCache: function(proxyRequest) {
    this.cache.lookup(proxyRequest.uri, function(err, uriData) {
      if ( ! err && uriData) {
        var varyValue = _.reduce(uriData.selecting || [], function(arr, header) {
          arr.push(proxyRequest.request.headers[header]);
        }, []).join(',');
        proxyRequest.cacheKey = this.cache.getKey(proxyRequest.uri, varyValue);
        this.fetchCacheRecords(proxyRequest);
      } else {
        this.cacheMiss(proxyRequest);
      }
    }.bind(this));
  },

  fetchCacheRecords: function(proxyRequest) {
    this.cache.fetchMeta(proxyRequest.cacheKey, 10, function(err, records) {
      console.log('Cache candidates result: '+records.length);
      if ( ! err && records.length) {
        var now = new Date();
        records = _.groupBy(records, function(rec){
          if (rec.exp >= now && ! rec.mr)  return 'fresh';
          if (rec.etag || rec.lm)  return 'stale';
          return 'purge';
        });
        if (records.purge) {
          this.cache.removeAll(records.purge);
        }
        if (records.fresh) {
          var doc = records.fresh.shift();
          this.cacheHit(proxyRequest, doc);
          if (records.fresh.length > 0) this.cache.removeAll(records.fresh);
          return;
        }
        else if (records.stale) {
          this.cacheRevalidate(proxyRequest, records.stale);
          return;
        }
      }
      this.cacheMiss(proxyRequest);
    }.bind(this));
  },

  cacheHit: function(proxyRequest, record) {
    this.cache.getResponse(record, function(proxyRequest, err, record) {
      if (err) {
        console.log('Cache hit error: '+err);
        this.cacheMiss(proxyRequest);
      } else {
        // TODO - respond with cache hit
      }
    }.bind(this, proxyRequest));
  },

  cacheMiss: function(proxyRequest) {
    console.log('Cache MISS: '+proxyRequest.uri);
    this.proxy.proxyRequest(proxyRequest.request, proxyRequest.response, {
      host: this.config.upstream[0],
      port: this.config.upstream[1],
      buffer: proxyRequest.proxyBuffer
    });
  },

  cacheRevalidate: function(proxyRequest, records) {
    // TODO - send revalidate request and respond with either response, or cache record
  }

};
