# Node.js Caching HTTP Proxy #

This node.js project utilizes the "http-cache" module but adds an RFC2616-compliant cache atop it.

It utilizes MongoDb as the default cache storage backend but could easily be extended with a different backend.

The primary feature that sets this caching proxy apart from others is the support for content-negotiation using ETag
 and revalidate requests including support for caching multiple versions of the same page and allowing the origin
 to select from them with If-None-Match.

## Status: ALPHA

## Installation:

    $ npm install mongodb lodash http-proxy
    $ git clone git://github.com/colinmollenhour/node-caching-proxy.git
