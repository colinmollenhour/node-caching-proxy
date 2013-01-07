var httpProxy = require('http-proxy');
//noinspection JSUnresolvedVariable
var _ = require('lodash')._;

var utf8Decoder = new (require('string_decoder').StringDecoder)('utf8');

var ProxyRequest = exports.ProxyRequest = function(req, res) { this.init(req, res); };
ProxyRequest.count = 0;
ProxyRequest.prototype = {

  init: function(req, res) {
    req.proxyRequest = this;
    this.protocol = req.isSpdy ? 'https' : (req.connection.pair ? 'https' : 'http');
    this.uri = this.protocol+'://'+req.headers.host+req.url;
    this.request = req;
    this.response = res;
    this.proxyEventBuffer = httpProxy.buffer(req);
    this.cacheKey = null;
    this.chunkCache = [];
    this.proxied = false;
    this.revalidate = false;
    this.candidates = null;
    ProxyRequest.count++;
  },

  onData: function(chunk) {
    this.chunkCache.push(chunk);
  },

  getBody: function() {
    var body = '', chunk;
    while (chunk = this.chunkCache.shift()) {
      body += utf8Decoder.write(chunk);
    }
    return body;
  },

  destroy: function() {
    if ( ! this.proxied) {
      this.proxyEventBuffer.destroy();
    }
    this.request.proxyRequest = null;
    this.request = this.response = this.proxyEventBuffer = this.chunkCache = this.candidates = null;
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
    this.proxy.on('start', this.proxyStart.bind(this));
    this.proxy.on('end', this.proxyComplete.bind(this));
  },

  debug: function(message) {
    if (this.config.debug) console.log(message);
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
    this.debug('Cache status: '+this.cacheStatus);
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

  serverHandler: function (req, res, proxy) {
    var proxyRequest = new ProxyRequest(req, res);
    req.on('proxyResponse', this.proxyResponse.bind(this));
    this.debug(req.method+': '+proxyRequest.uri);
    if (this.getCache() && this.canUseCache(req)) {
      this.checkCache(proxyRequest);
    } else {
      this.cacheMiss(proxyRequest);
    }
  },

  proxyStart: function(req, res, target) {
    var proxyRequest = req.proxyRequest;
    if (proxyRequest.revalidate)
    {
      // Add revalidating headers to request
      var etags = [], lm = null;
      proxyRequest.candidates.forEach(function(val){
        if (val.etag) etags.push(val.etag);
        if (val.lm && ( ! lm || lm < val.lm)) lm = val.lm;
      });
      if (etags.length) {
        req.headers['if-none-match'] = etags.join(', ');
      }
      if (lm) {
        req.headers['if-modified-since'] = lm.toGMTString();
      }
    }
  },

  proxyResponse: function(req, res, upstreamResponse) {
    var proxyRequest = req.proxyRequest;
    this.debug('Proxied request: '+proxyRequest.uri+' ('+upstreamResponse.statusCode+')');
    if (req.method == 'GET') {
      switch (upstreamResponse.statusCode) {
        case 200:
        case 301:
        case 302:
        case 404:
          upstreamResponse.originalHeaders = upstreamResponse.headers;
          upstreamResponse.headers = this.filterResponseHeaders(upstreamResponse.headers);
          upstreamResponse.on('data', proxyRequest.onData.bind(proxyRequest));
          break;
        case 304:
          // Do not intercept unless revalidating cached response
          if (proxyRequest.revalidate) {
            var etag, lm, found;
            if (etag = upstreamResponse.headers['etag']) {
              found = _.find(proxyRequest.candidates, function(val){ return etag == val.etag; });
            } else if (lm = upstreamResponse.headers['last-modified']) {
              found = _.find(proxyRequest.candidates, function(val){ return lm == val.lm; });
            }
            if (found) {
              var newheaders = _.omit(upstreamResponse.headers, 'connection', 'keep-alive', 'set-cookie', 'date');
              this.cacheHit(proxyRequest, found, newheaders);
            } else {
              this.cacheMiss(proxyRequest);
            }
            upstreamResponse.on('end', function() {
              this.proxyComplete(req, res, upstreamResponse, true);
            }.bind(this));
            throw 'intercepted';
          } else {
            upstreamResponse.headers = this.filterResponseHeaders(upstreamResponse.headers);
          }
          break;
        default:
          break;
      }
    }
  },

  proxyComplete: function(req, res, upstreamResponse, keep) {
    var proxyRequest = req.proxyRequest;
    this.debug('Proxied request complete: '+proxyRequest.uri+' ('+upstreamResponse.statusCode+')');
    if (req.method == 'GET') {
      switch (upstreamResponse.statusCode) {
        case 200:
        case 301:
        case 302:
        case 404:
          this.storeResponse(proxyRequest, upstreamResponse);
          break;
        default:
          break;
      }
    }
    if ( ! keep) proxyRequest.destroy();
  },

  storeResponse: function(proxyRequest, upstreamResponse) {
    if ( ! this.getCache() || ! proxyRequest.chunkCache.length)  return;

    var now = Math.ceil((new Date()).getTime()/1000);
    var headers = upstreamResponse.originalHeaders;

    // Get cache-control directives
    var expires = _.has(headers, 'expires') ? headers['expires'] : false;
    if ( ! expires && ! _.has(headers, 'cache-control') && ! _.has(headers, 'x-accel-cache-control'))  return;

    var cacheControlStr = headers['x-accel-cache-control'] || headers['cache-control'] || '';
    if (cacheControlStr.match(/no-store/))  return;
    var cacheControl = cacheControlStr.split(/, ?/);

    var maxage = (cacheControlStr.match(/max-age=(\d+)/) || [,false])[1];
    var smaxage = (cacheControlStr.match(/s-maxage=(\d+)/) || [,false])[1];
    var policy = _.find(cacheControl, function(tok){ return _.contains(['public', 'private'], tok); });
    var vary = headers['vary'];
    var revalidate = vary == '*' || null != cacheControlStr.match(/no-cache|(must|proxy)-revalidate/);

    if ( ! policy && (maxage !== false || smaxage !== false || expires !== false)) {
      policy = 'public';
    }
    if ( ! policy || policy == 'private')  return;

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
    if (result = cacheControlStr.match(/lifetime=(\d+)/)) {
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
    var etag = upstreamResponse.statusCode == 200 ? (headers['etag'] || '') : '';
    var lm = upstreamResponse.statusCode == 200 && headers['last-modified'] ? Date.parse(headers['last-modified']) : false;

    // Don't cache cloaked headers from upstream responses
    headers = _.omit(this.filterResponseHeaders(headers), 'set-cookie', 'date', 'keep-alive');

    // Update index and store response
    var uriData = {
      selecting: selecting
    };
    var responseData = {
      status: upstreamResponse.statusCode,
      headers: headers,
      body: proxyRequest.getBody(),
      etag: etag,
      lm: lm,
      exp: expiration,
      mr: revalidate
    };
    if ( ! proxyRequest.cacheKey) {
      var varyValue = _.reduce(selecting, function(arr, header) {
        arr.push(proxyRequest.request.headers[header]);
      }, []).join(',');
      proxyRequest.cacheKey = this.cache.getKey(proxyRequest.uri, varyValue);
    }
    this.cache.storeResponse(proxyRequest.cacheKey, responseData, lifetime, function(err) {
      if (err) {
        console.log('Error saving response in cache: '+err);
      } else {
        this.debug('Saved record to cache: '+proxyRequest.uri+' ('+proxyRequest.cacheKey+')');
        this.cache.updateIndex(proxyRequest.uri, uriData); // Update uri index after record so there are no false hits
      }
    }.bind(this));
  },

  canUseCache: function(request) {
    if (request.method != 'GET')  return false;
    // TODO - allow disabling user agent use of no-store
    if ((request.headers['cache-control'] || '').match(/no-store/)) return false;
    return true;
  },

  filterResponseHeaders: function(headers) {
    var toCloak = headers['x-accel-cloak'] ? headers['x-accel-cloak'].toLowerCase().split(/, ?/) : [];
    if (toCloak.length) headers = _.omit.apply(null, toCloak.unshift(headers));
    return _.omit(headers, function(value, key){ return key.match(/^x-accel/); });
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
      this.debug('Cache candidates result: '+(records ? records.length : 0));
      if (err) console.log('Error fetching record metadata: '+err);
      else if (records.length) {
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
          var notmodified, found, inm, ims;
          if (inm = proxyRequest.request.headers['if-none-match']) {
            var etags = _.intersection(inm.split(/, ?/), _.pluck(records.fresh, 'etag'));
            if (etags.length) {
              notmodified = {'etag': etags[0]};
              found = _.where(records.fresh, notmodified)[0];
              if (found.lm) {
                notmodified['last-modified'] = found.lm.toGMTString();
              }
            }
          } else if (ims = proxyRequest.request.headers['if-modified-since']) {
            if (ims = Date.parse(ims)) {
              found = _.find(records.fresh, function(val){ return val.lm == ims; });
              if (found) {
                notmodified = {'last-modified': found.lm.toGMTString()};
              }
            }
          }
          if (notmodified && found.status === 200) {
            this.cacheNotModified(proxyRequest, found, notmodified);
            return;
          }
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

  cacheNotModified: function(proxyRequest, record, addheaders) {
    // TODO - response needs to include original headers (omit content-length)
    addheaders['X-Accel-Status'] = 'Cache HIT';
    var response = proxyRequest.response;
    response.writeHead(304, _.extend({}, addheaders));
    response.end();
    this.cache.logHit(proxyRequest.uri);
    proxyRequest.destroy();
  },

  cacheHit: function(proxyRequest, record, addheaders) {
    this.cache.getResponse(record, function(err, record) {
      if (err) {
        this.debug('Cache hit error: '+err);
        this.cacheMiss(proxyRequest);
      } else {
        if (this.config.debug) addheaders['X-Accel-Status'] = 'Cache HIT';
        var response = proxyRequest.response;
        response.writeHead(record.status, _.extend(record.headers, addheaders || {}));
        response.end(record.body);
        this.cache.logHit(proxyRequest.uri);
        proxyRequest.destroy();
      }
    }.bind(this));
  },

  cacheRevalidate: function(proxyRequest, candidates) {
    proxyRequest.revalidate = true;
    proxyRequest.candidates = candidates;
    this.cacheMiss(proxyRequest);
  },

  cacheMiss: function(proxyRequest) {
    if (proxyRequest.revalidate) this.debug('Cache REVALIDATE: '+proxyRequest.uri);
    else                         this.debug('Cache MISS: '+proxyRequest.uri);
    proxyRequest.proxied = true;
    this.proxy.proxyRequest(proxyRequest.request, proxyRequest.response, {
      host: this.config.upstream[0],
      port: this.config.upstream[1],
      buffer: proxyRequest.proxyEventBuffer
    });
  }

};
