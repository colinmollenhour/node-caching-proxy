# Node.js Caching HTTP Proxy #

This node.js project utilizes the "http-cache" module but adds an
RFC2616-compliant cache atop it. It utilizes MongoDb as the default cache
storage backend but could easily be extended with a different backend.

The primary feature that sets this caching proxy apart from others is the
full support for ETag, Vary and revalidate requests including simultaneous
storage for multiple versions of the same page and allowing the origin to
select from them with If-None-Match (server-side content-negotiation).

## Status: ALPHA

## Installation:

    $ npm install mongodb lodash http-proxy
    $ git clone git://github.com/colinmollenhour/node-caching-proxy.git

## Special (Non-RFC) Features

### X-Accel-Expires ("off"|int)

Set to "off" to prevent caching, or give a lifetime in seconds for the cache to
hold the page in storage.

### X-Accel-Cache-Control (cache_control)

If an X-Accel-Cache-Control header is present it will be used in place of the
Cache-Control header in determining the caching policy. This allows the origin
to specify a separate Cache-Control header for clients and the proxy.

### X-Accel-Cloak (header_name, ...)

List of headers which should be removed from the response before proxying
upstream. All X-Accel headers will be removed regardless.
