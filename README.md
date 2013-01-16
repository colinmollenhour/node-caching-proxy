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

### X-Accel-Vary-Cookie (cookie_name, ...)

When used in conjunction with "Vary: *" this header tells the proxy which
cookie value was used to determine the response. Allows simultaneous use of
ETag/Vary and anti-stampeding if the client's identifying cookie is present.

## TODO

 - Add anti-stampeding feature (serve stale response when already updating a given page)
 - Add pre-fetching of 503 pages in case upstream becomes unreachable and no stale record exists

## License

This module is distributed under the GPLv3 license. To receive a copy
under a different license please contact the author.

http-caching-proxy
Copyright (C) 2013  Colin Mollenhour (http://colin.mollenhour.com)

This program is free software: you can redistribute it and/or modify
it under the terms of the GNU General Public License as published by
the Free Software Foundation, either version 3 of the License, or
(at your option) any later version.

This program is distributed in the hope that it will be useful,
but WITHOUT ANY WARRANTY; without even the implied warranty of
MERCHANTABILITY or FITNESS FOR A PARTICULAR PURPOSE.  See the
GNU General Public License for more details.

You should have received a copy of the GNU General Public License
along with this program.  If not, see http://www.gnu.org/licenses/

