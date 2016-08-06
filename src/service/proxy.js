import uniqid from 'uniqid';

export default class Proxy {

  constructor(update, config, urlMapper, createHoxy) {
    this._requests = [];
    this._urlMapper = urlMapper;
    this._config = config;
    this._update = update;
    this._isCachingEnabled = false;

    this._proxy = createHoxy();
    this._proxy.intercept('response-sent', this._onResponseSent.bind(this));
    this._proxy.intercept('request', this._onInterceptRequest.bind(this));
    this._proxy.intercept('response', this._onInterceptResponse.bind(this));
  }

  _onResponseSent(req) {
    req.completed = new Date().getTime();
    req.took = req.completed - req.started;
    req.done = true;
    this._update();
  }

  _onInterceptResponse(request, response) {
    if (!this._isCachingEnabled) {
      delete response.headers['if-modified-since'];
      delete response.headers['if-none-match'];
      delete response.headers['last-modified'];
      delete response.headers.etag;

      response.headers.expires = '0';
      response.headers.pragma = 'no-cache';
      response.headers['cache-control'] = 'no-cache';
    }
  }

  _onInterceptRequest(request, response, cycle) {
    const fullUrl = request.fullUrl();

    request.done = false;
    request.id = uniqid();
    request.started = new Date().getTime();
    request.original = {
      fullUrl,
      port: request.port,
      protocol: request.protocol,
      hostname: request.hostname,
      url: request.url
    };

    const requestContainer = {
      request: request,
      response: response
    };

    try {
      this._requests.unshift(requestContainer);
      if (this._requests.length > this._config.maxLogEntries) {
        this._requests.pop();
      }

      request.isMappingActive = this._urlMapper.isActiveMappedUrl(fullUrl);
      request.isMappedUrl = this._urlMapper.isMappedUrl(fullUrl);

      if (request.isMappingActive) {
        const mappedUrl = this._urlMapper.get(fullUrl);
        request.isLocal = mappedUrl.isLocal;
        request.newUrl = mappedUrl.newUrl;

        if (request.isLocal) {
          return cycle.serve({
            path: request.newUrl
          }, () => {
            this._update();
          });
        }

        request.fullUrl(request.newUrl);
      }

      this._update();
    } catch (e) {
      console.error(e); // eslint-disable-line
    }
  }

  getRequestById(id) {
    if (!id) return null;
    return this._requests.find((request) => request.request.id === id);
  }

  getRequestData(filter) {
    // converts request into an IPC-friendly Object
    // (ES6 class getters used in Hoxy are not enumerable)
    const convertRequest = (request) => {
      return Object.assign({}, request, request._data, {
        query: request.query,
        params: request.params,
        fullUrl: typeof request.fullUrl === 'function' ? request.fullUrl() : request.fullUrl,
        _data: null
      });
    };

    const matchesFilter = (request) =>
      request.fullUrl().includes(filter) || request.original.fullUrl.includes(filter)

    const requests = this._requests.reduce((results, {request, response}) => {
      if (filter && !matchesFilter(request)) return results;

      const container = {
        id: request.id
      };
      container.request = convertRequest(request);
      container.request.original = convertRequest(request.original);
      container.response = Object.assign({}, response, response._data, {
        params: response.params,
        _data: null
      });

      results.push(container);
      return results;
    }, []);

    return {
      requests,
      totalCount: this._requests.length,
      filteredCount: requests.length
    };
  }

  clear() {
    this._requests = [];
    this._update();
  }

  /**
   * Adjusts the proxy to throttle the overall connection speed to the provided kilobytes/second.
   * @param rate maximum overall speed in kilobytes/second
   */
  slow(rate) {
    rate *= 1024;
    this._proxy.slow({rate});
  }

  /**
   * Disables throttling, allowing the proxy to run at maximum speed
   */
  disableThrottling() {
    this._proxy.slow({});
  }
}
