var httpProxy      = require('http-proxy')
   ,events         = require('events')
   ,util           = require('util')
   ,_              = require('lodash')
   ,utf8Decoder    = new (require('string_decoder').StringDecoder)('utf8')
  ;

/**
 * Creates a wrapper for HttpProxy to handle caching.
 *
 * Events:
 *
 *  - cache:connected (self)

 * @type {Function}
 */
var CachingProxy = module.exports = function(config){ this.init(config); events.EventEmitter.call(this); };
util.inherits(CachingProxy, events.EventEmitter)
_.extend(CachingProxy.prototype, {

  cache: null,
  cacheStatus: null,

  init: function(config) {
    this.config = _.extend({
      defaultExpiration: 3600,
      defaultLifetime: 3600
    }, config || {});
    this.proxy = new httpProxy.HttpProxy({target: this.config.target});
    this.proxy.on('start', this.proxyStart.bind(this));
    this.proxy.on('end', this.proxyComplete.bind(this));
  },

  debug: function(message) {
    if (this.config.debug) console.log(message);
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
      this.emit('cache:connected', this);
    }.bind(this));
    return false;
  },

  serverHandler: function (req, res) {
    var proxyRequest = new ProxyRequest(req, res);
    req.once('proxyResponse', this.proxyResponse.bind(this));
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
      var intercepted, found, newheaders;
      switch (upstreamResponse.statusCode) {
        case 200:
        case 203:
        case 300:
        case 301:
        case 302:
        case 404:
        case 410:
          // Prepare to store regular response in cache
          upstreamResponse.originalHeaders = upstreamResponse.headers;
          upstreamResponse.headers = this.filterResponseHeaders(upstreamResponse.headers);
          upstreamResponse.on('data', proxyRequest.onData.bind(proxyRequest));
          break;
        case 304:
          // Revalidating cached response was successful
          if (proxyRequest.revalidate) {
            var etag, lm;
            if (etag = upstreamResponse.headers['etag']) {
              found = _.find(proxyRequest.candidates, function(val){ return etag == val.etag; });
            } else if (lm = upstreamResponse.headers['last-modified']) {
              found = _.find(proxyRequest.candidates, function(val){ return lm == val.lm; });
            }
            if (found) {
              newheaders = _.omit(upstreamResponse.headers, 'connection', 'keep-alive', 'date');
              this.cacheHit(proxyRequest, found, newheaders, 'REVALIDATED');
            } else {
              // TODO - prevent infinite loop
              this.cacheMiss(proxyRequest);
            }
            intercepted = true;
          } else {
            upstreamResponse.headers = this.filterResponseHeaders(upstreamResponse.headers);
          }
          break;
        case 500:
        case 502:
        case 503:
        case 504:
          // Proxy request failed, see if stale item or custom error page can be used
          if (proxyRequest.revalidate) {
            found = _.find(proxyRequest.candidates, function(val){
              return (val.sr && ! val.mr);
            });
            if (found) {
              upstreamResponse.headers = this.filterResponseHeaders(upstreamResponse.headers);
              newheaders = _.omit(upstreamResponse.headers, 'connection', 'keep-alive', 'date');
              // TODO - prevent infinite loop
              this.cacheHit(proxyRequest, found, newheaders, 'STALE');
              intercepted = true;
            } else {
              // TODO - attempt to serve custom error page
            }
          }
          break;
        default:
          break;
      }
      if (intercepted) {
        upstreamResponse.once('end', function() {
          this.proxyComplete(req, res, upstreamResponse, true);
        }.bind(this));
        throw 'intercepted';
      }
    }
  },

  proxyComplete: function(req, res, upstreamResponse, keep) {
    var proxyRequest = req.proxyRequest;
    this.debug('Proxied request complete: '+proxyRequest.uri+' ('+upstreamResponse.statusCode+')');
    if (req.method == 'GET') {
      switch (upstreamResponse.statusCode) {
        case 200:
        case 203:
        case 300:
        case 301:
        case 302:
        case 404:
        case 410:
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

    var maxage = (cacheControlStr.match(/max-age=(\d+)/) || [,false])[1];
    var smaxage = (cacheControlStr.match(/s-maxage=(\d+)/) || [,false])[1];
    var domain = (cacheControlStr.match(/private|public/) || [false])[0];
    if ( ! domain && (maxage !== false || smaxage !== false || expires !== false)) {
      domain = 'public';
    }
    if ( ! domain || domain == 'private')  return;

    var policy = (cacheControlStr.match(/no-store|no-cache/) || [false])[0];
    var policyParam = (cacheControlStr.match(/(?:no-cache)="([^"]+)"/) || [,false])[1];
    var vary = headers['vary'];
    var mustRevalidate = (policy == 'no-cache' && ! policyParam) || vary == '*' || null != cacheControlStr.match(/must-revalidate/);
    var shouldRevalidate = mustRevalidate || null != cacheControlStr.match(/proxy-revalidate/);

    // Get cache record freshness expiration
    var expiration = new Date();
    if (smaxage !== false) {
      expiration.setSeconds(expiration.getSeconds() + smaxage);
      shouldRevalidate = true; // s-maxage implies proxy-revalidate
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
      expiration.setSeconds(expiration.getSeconds() + this.config.defaultExpiration);
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
      lifetime = this.config.defaultLifetime;
    }

    // Get freshness identifiers
    var etag = upstreamResponse.statusCode == 200 ? (headers['etag'] || '') : '';
    var lm = upstreamResponse.statusCode == 200 && headers['last-modified'] ? Date.parse(headers['last-modified']) : false;

    // Get sorted Vary values for later updating uri index
    var selecting = ! vary || vary == '*' ? [] : vary.toLowerCase().split(/, ?/).sort();
    if (headers['x-accel-vary-cookie']) { // Vary on specific cookie values, not the full cookie
      selecting.push('cookie:'+headers['x-accel-vary-cookie'].split(/, ?/).sort().join(','));
    }

    // Don't cache cloaked headers from upstream responses
    headers = _.omit(this.filterResponseHeaders(headers), 'connection', 'keep-alive', 'date');
    if (policyParam) {
      (policyParam = policyParam.split(/, ?/)).unshift(headers);
      headers = _.omit.apply(null, policyParam);
    }

    // Update index and store response
    var uriData = {
      selecting: selecting,
      eol: new Date(expiration.getTime() + (lifetime*1000))
    };
    var responseData = {
      status: upstreamResponse.statusCode,
      headers: headers,
      body: proxyRequest.getBody(),
      etag: etag,
      lm: lm,
      exp: expiration,
      sr: shouldRevalidate,
      mr: mustRevalidate
    };
    if ( ! proxyRequest.cacheKey || (proxyRequest.selecting && proxyRequest.selecting.join(',') != selecting.join(','))) {
      proxyRequest.cacheKey = this.cache.getKey(proxyRequest.uri, proxyRequest.getVaryValue(selecting));
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
    this.cache.lookup(proxyRequest.uri, function(uriData) {
      if (uriData) {
        proxyRequest.cacheKey = this.cache.getKey(proxyRequest.uri, proxyRequest.getVaryValue(uriData.selecting));
        proxyRequest.selecting = uriData.selecting;
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
          if (rec.exp >= now && ! (rec.sr || rec.mr))  return 'fresh';
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
          this.cacheHit(proxyRequest, doc, null, 'FRESH');
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

  cacheHit: function(proxyRequest, record, addheaders, status) {
    this.cache.getResponse(record, function(err, record) {
      if (err) {
        this.debug('Cache hit error: '+err);
        this.cacheMiss(proxyRequest);
      } else {
        if (this.config.debug) addheaders['X-Accel-Status'] = 'Cache HIT'+(status ? ' ('+status+')':'');
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

});

/**
 * Container for single request data, response data and other meta data.
 *
 * @param req
 * @param res
 * @constructor
 */
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
    this.selecting = null;
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

  // Given a set of selectors for the request, compile the fingerprint which allows
  // matching a request to a cached response variation.
  // Example:
  //   Accept-Encoding: gzip
  //   Cookie: foo=bar; loggedin=0
  // E.g. ["accept-encoding","cookie:loggedin"]
  getVaryValue: function(selecting) {
    return _.reduce(selecting || [], function (arr, selector) {
      var cookieSelectors;
      if (this.request.headers['cookie']
        && (cookieSelectors = selector.match(/^cookie:(.*)$/)) !== null
        ) {
        // Support special selector which chooses only certain cookies to be considered
        var requestCookies = _.reduce(this.request.headers['cookie'].split(/; ?/), function (memo, keyVal) {
          if (keyVal = keyVal.match(/^([^$=]+)=(.*)$/)) {
            memo[keyVal[1]] = keyVal[0];
          }
        }, []);
        var requestSelectorCookies = _.map(cookieSelectors[1].split(','), function (value) {
          return _.has(requestCookies, value) ? requestCookies[value] : null;
        });
        arr.push(requestSelectorCookies.join(';'));
      } else {
        arr.push(this.request.headers[selector]);
      }
    }, []).join(',');
  },

  destroy: function() {
    if ( ! this.proxied) {
      this.proxyEventBuffer.destroy();
    }
    this.request.proxyRequest = null;
    this.request = this.response = this.proxyEventBuffer = this.chunkCache = this.candidates = null;
  }

};
