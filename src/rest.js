import {json} from 'd3-fetch'
import Logger from './logger.js'

const logger = Logger.create('Rest')

const options = {
  credentials: 'include',
  headers: {
    'Accept': 'application/json',
    'Content-Type': 'application/json',
    // never expiring token
    'Authorization': 'Bearer ' + JWT_TOKEN // eslint-disable-line no-undef
  }
}

const normalizeTag = keyspace => tag => {
  tag.currency = keyspace.toUpperCase()
  tag.keyspace = keyspace
  return tag
}

const normalizeNodeTags = keyspace => node => {
  if (!node.tags || !Array.isArray(node.tags)) return node
  node.tags.forEach(normalizeTag(keyspace))
  return node
}

export default class Rest {
  constructor (baseUrl, prefixLength) {
    this.baseUrl = baseUrl
    this.prefixLength = prefixLength
    this.json = this.remoteJson
  }
  remoteJson (keyspace, url, field) {
    url = this.keyspaceUrl(keyspace) + (url.startsWith('/') ? '' : '/') + url
    return json(url, options)
      .then(result => {
        if (field) {
        // result is an array
          if (!Array.isArray(result[field])) {
            logger.warn(`${field} is not in result or not an array, calling ${url}`)
          } else {
            result[field].forEach(item => { item.keyspace = keyspace })
          }
        } else if (!Array.isArray(result)) {
          result.keyspace = keyspace
        }
        return Promise.resolve(result)
      }, error => {
        error.keyspace = keyspace
        error.requestURL = url
        return Promise.reject(error)
      })
  }
  csv (keyspace, url) {
    url = this.keyspaceUrl(keyspace) + (url.startsWith('/') ? '' : '/') + url
    if (url.indexOf('?') !== -1) {
      url = url.replace('?', '.csv?')
    } else {
      url += '.csv'
    }
    return fetch(url, options) // eslint-disable-line no-undef
      .then(resp => resp.blob())
  }
  keyspaceUrl (keyspace) {
    return this.baseUrl + (keyspace ? '/' + keyspace : '')
  }
  disable () {
    this.json = (url) => {
      return Promise.resolve()
    }
  }
  enable () {
    this.json = this.remoteJson
  }
  search (keyspace, str, limit) {
    return this.json(keyspace, '/search?q=' + encodeURIComponent(str) + '&limit=' + limit)
  }
  searchLabels (str, limit) {
    return this.json(null, '/labelsearch?q=' + encodeURIComponent(str) + '&limit=' + limit)
  }
  node (keyspace, request) {
    return this.json(keyspace, `/${request.type}_with_tags/${request.id}`)
      .then(normalizeNodeTags(keyspace))
  }
  clusterForAddress (keyspace, id) {
    logger.debug('rest clusterForAddress', id)
    return this.json(keyspace, '/address/' + id + '/cluster_with_tags')
      .then(normalizeNodeTags(keyspace))
  }
  transactions (keyspace, request, csv) {
    let url =
       '/' + request.params[1] + '/' + request.params[0] + '/transactions'
    if (csv) return this.csv(keyspace, url)
    url += '?' +
      (request.nextPage ? 'page=' + request.nextPage : '') +
      (request.pagesize ? '&pagesize=' + request.pagesize : '')
    return this.json(keyspace, url, request.params[1] === 'block' ? 'txs' : 'transactions')
  }
  addresses (keyspace, request, csv) {
    let url = '/cluster/' + request.params + '/addresses'
    if (csv) return this.csv(keyspace, url)
    url += '?' +
      (request.nextPage ? 'page=' + request.nextPage : '') +
      (request.pagesize ? '&pagesize=' + request.pagesize : '')
    return this.json(keyspace, url, 'addresses')
  }
  tags (keyspace, {id, type}, csv) {
    logger.debug('fetch tags', keyspace)
    let url = '/' + type + '/' + id + '/tags'
    if (csv) return this.csv(keyspace, url)
    return this.json(keyspace, url).then(tags => tags.map(tag => normalizeTag(tag.currency.toLowerCase())(tag)))
  }
  egonet (keyspace, type, id, isOutgoing, limit) {
    let dir = isOutgoing ? 'out' : 'in'
    return this.json(keyspace, `/${type}/${id}/egonet?limit=${limit}&direction=${dir}`, 'nodes')
  }
  clusterAddresses (keyspace, id, limit) {
    return this.json(keyspace, `/cluster/${id}/addresses?pagesize=${limit}`, 'addresses')
  }
  transaction (keyspace, txHash) {
    return this.json(keyspace, `/tx/${txHash}`)
  }
  block (keyspace, height) {
    return this.json(keyspace, `/block/${height}`)
  }
  label (id) {
    return this.json(null, `/label/${id}`)
  }
  neighbors (keyspace, id, type, isOutgoing, pagesize, nextPage, csv) {
    let dir = isOutgoing ? 'out' : 'in'
    let url = `/${type}/${id}/neighbors?direction=${dir}`
    if (csv) return this.csv(keyspace, url)
    url += '&' +
      (nextPage ? 'page=' + nextPage : '') +
      (pagesize ? '&pagesize=' + pagesize : '')
    return this.json(keyspace, url, 'neighbors')
  }
  stats () {
    return this.json(null, '/stats')
  }
  searchNeighbors ({id, type, isOutgoing, depth, breadth, params}) {
    let dir = isOutgoing ? 'out' : 'in'
    let keyspace = id[2]
    id = id[0]
    let searchCrit = ''
    if (params.category) {
      searchCrit = `category=${params.category}`
    } else if (params.addresses) {
      searchCrit = 'addresses=' + params.addresses.join(',')
    }
    let url =
      `/${type}/${id}/search?direction=${dir}&${searchCrit}&depth=${depth}&breadth=${breadth}`
    let addKeyspace = (node) => {
      if (!node.paths) { return node }
      (node.paths || []).forEach(path => {
        path.node.keyspace = keyspace
        path.matchingAddresses.forEach(address => { address.keyspace = keyspace })
        addKeyspace(path)
      })
      return node
    }
    return this.json(keyspace, url).then(addKeyspace)
  }
}
