import Store from './store.js'
import Search from './search/search.js'
import Browser from './browser.js'
import Rest from './rest.js'
import Layout from './layout.js'
import NodeGraph from './nodeGraph.js'
import Config from './config.js'
import Menu from './menu.js'
import Statusbar from './statusbar.js'
import Landingpage from './landingpage.js'
import moment from 'moment'
import numeral from 'numeral'
import FileSaver from 'file-saver'
import {pack, unpack} from 'lzwcompress'
import {Base64} from 'js-base64'
import Logger from './logger.js'
import {map} from 'd3-collection'
import NeighborsTable from './browser/neighbors_table.js'
import TagsTable from './browser/tags_table.js'
import TransactionsTable from './browser/transactions_table.js'
import BlockTransactionsTable from './browser/block_transactions_table.js'

const logger = Logger.create('Model') // eslint-disable-line no-unused-vars

const baseUrl = REST_ENDPOINT // eslint-disable-line no-undef

let supportedKeyspaces

try {
  supportedKeyspaces = JSON.parse(SUPPORTED_KEYSPACES) // eslint-disable-line no-undef
  if (!Array.isArray(supportedKeyspaces)) throw new Error('SUPPORTED_KEYSPACES is not an array')
} catch (e) {
  console.error(e.message)
  supportedKeyspaces = []
}

const searchlimit = 100
const prefixLength = 5
const labelPrefixLength = 3

// synchronous messages
// get handled by model in current rendering frame
const syncMessages = ['search']

// messages that change the graph
const dirtyMessages = [
  'addNode',
  'addNodeCont',
  'resultNode',
  'resultClusterAddresses',
  'resultEgonet',
  'removeNode',
  'resultSearchNeighbors',
  'dragNodeEnd'
]

const historyPushState = (keyspace, type, id) => {
  let s = window.history.state
  if (s && keyspace === s.keyspace && type === s.type && id == s.id) return // eslint-disable-line eqeqeq
  let url = '/'
  if (type && id) {
    url = '#!' + (keyspace ? keyspace + '/' : '') + [type, id].join('/')
  }
  if (url === '/') {
    window.history.pushState({keyspace, type, id}, null, url)
    return
  }
  window.history.replaceState({keyspace, type, id}, null, url)
}

const degreeThreshold = 100

let defaultLabelType =
      { clusterLabel: 'id',
        addressLabel: 'id'
      }

const defaultCurrency = 'satoshi'

const defaultTxLabel = 'noTransactions'

const allowedUrlTypes = ['address', 'cluster', 'transaction', 'block', 'label']

const fromURL = (url, keyspaces) => {
  let hash = url.split('#!')[1]
  if (!hash) return {id: '', type: '', keyspace: ''} // go home
  let split = hash.split('/')
  let id = split[2]
  let type = split[1]
  let keyspace = split[0]
  if (split[0] === 'label') {
    keyspace = null
    type = split[0]
    id = split[1]
  } else if (keyspaces.indexOf(keyspace) === -1) {
    logger.error(`invalid keyspace ${keyspace}`)
    return
  }
  if (allowedUrlTypes.indexOf(type) === -1) {
    logger.error(`invalid type ${type}`)
    return
  }
  return {keyspace, id, type}
}

// time to wait after a dirty message before creating a snapshot
const idleTimeToSnapshot = 2000

export default class Model {
  constructor (dispatcher, locale) {
    this.dispatcher = dispatcher
    this.locale = locale
    this.isReplaying = false
    this.showLandingpage = true
    this.keyspaces = supportedKeyspaces
    this.snapshotTimeout = null
    this.call = (message, data) => {
      if (this.isReplaying) {
        logger.debug('omit calling while replaying', message, data)
        return
      }

      let fun = () => {
        logger.boldDebug('calling', message, data)
        this.dispatcher.call(message, null, data)
        if (dirtyMessages.indexOf(message) === -1) {
          this.render()
          return
        }
        this.isDirty = true
        this.dispatcher.call('disableUndoRedo')
        this.render()

        if (this.snapshotTimeout) clearTimeout(this.snapshotTimeout)
        this.snapshotTimeout = setTimeout(() => {
          this.call('createSnapshot')
          this.snapshotTimeout = null
        }, idleTimeToSnapshot)
      }

      if (syncMessages.indexOf(message) !== -1) {
        fun()
      } else {
        setTimeout(fun, 1)
      }
    }

    this.statusbar = new Statusbar(this.call)
    this.rest = new Rest(baseUrl, prefixLength)
    this.createComponents()

    this.dispatcher.on('search', ({term, types, keyspaces, isInDialog}) => {
      let search = isInDialog ? this.menu.search : this.search
      if (!search) return
      search.setSearchTerm(term, labelPrefixLength)
      search.hideLoading()
      keyspaces.forEach(keyspace => {
        if (search.needsResults(keyspace, searchlimit, prefixLength)) {
          if (search.timeout[keyspace]) clearTimeout(search.timeout[keyspace])
          search.showLoading()
          search.timeout[keyspace] = setTimeout(() => {
            if (types.indexOf('addresses') !== -1 || types.indexOf('transactions') !== -1) {
              this.mapResult(this.rest.search(keyspace, term, searchlimit), 'searchresult', {term, isInDialog})
            }
          }, 250)
        }
      })
      if (search.needsLabelResults(searchlimit, labelPrefixLength)) {
        if (search.timeoutLabels) clearTimeout(search.timeoutLabels)
        search.showLoading()
        search.timeoutLabels = setTimeout(() => {
          if (types.indexOf('labels') !== -1) {
            this.mapResult(this.rest.searchLabels(term, searchlimit), 'searchresultLabels', {term, isInDialog})
          }
        }, 250)
      }
    })
    this.dispatcher.on('clickSearchResult', ({id, type, keyspace, isInDialog}) => {
      if (isInDialog) {
        if (!this.menu.search || type !== 'address') return
        this.menu.addSearchAddress(id)
        this.menu.search.clear()
        return
      }
      this.browser.loading.add(id)
      this.statusbar.addLoading(id)
      if (this.showLandingpage) {
        this.showLandingpage = false
        this.layout.setUpdate(true)
      }
      this.search.clear()
      if (type === 'address' || type === 'cluster') {
        this.graph.selectNodeWhenLoaded([id, type, keyspace])
        this.mapResult(this.rest.node(keyspace, {id, type}), 'resultNode', id)
      } else if (type === 'transaction') {
        this.mapResult(this.rest.transaction(keyspace, id), 'resultTransactionForBrowser', id)
      } else if (type === 'label') {
        this.mapResult(this.rest.label(id), 'resultLabelForBrowser', id)
      } else if (type === 'block') {
        this.mapResult(this.rest.block(keyspace, id), 'resultBlockForBrowser', id)
      }
      this.statusbar.addMsg('loading', type, id)
    })
    this.dispatcher.on('blurSearch', (isInDialog) => {
      let search = isInDialog ? this.menu.search : this.search
      if (!search) return
      search.clear()
    })
    this.dispatcher.on('fetchError', ({context, msg, error}) => {
      switch (msg) {
        case 'searchresult':
          let search = context && context.isInDialog ? this.menu.search : this.search
          if (!search) return
          search.hideLoading()
          search.error(error.keyspace, error.message)
          // this.statusbar.addMsg('error', error)
          break
        case 'searchresultLabels':
          search = context && context.isInDialog ? this.menu.search : this.search
          if (!search) return
          search.hideLoading()
          search.errorLabels(error.message)
          // this.statusbar.addMsg('error', error)
          break
        case 'resultNode':
          this.statusbar.removeLoading((context && context.data && context.data.id) || context)
          this.statusbar.addMsg('error', error)
          break
        case 'resultTransactionForBrowser':
          this.statusbar.removeLoading(context)
          break
        case 'resultBlockForBrowser':
          this.statusbar.removeLoading(context)
          break
        case 'resultLabelForBrowser':
          this.statusbar.removeLoading(context)
          break
        case 'resultEgonet':
          this.statusbar.removeLoading(`neighbors of ${context.type} ${context.id[0]}`)
          break
        case 'resultClusterAddresses':
          this.statusbar.removeLoading('addresses of cluster ' + context[0])
          break
        default:
          this.statusbar.addMsg('error', error)
      }
    })
    this.dispatcher.on('resultNode', ({context, result}) => {
      let a = this.store.add(result)
      if (context && context.focusNode) {
        let f = this.store.get(context.focusNode.keyspace, context.focusNode.type, context.focusNode.id)
        if (f) {
          if (context.focusNode.isOutgoing === true) {
            this.store.linkOutgoing(f.id, a.id, f.keyspace, context.focusNode.linkData)
          } else if (context.focusNode.isOutgoing === false) {
            this.store.linkOutgoing(a.id, f.id, a.keyspace, context.focusNode.linkData)
          }
        }
      }
      let anchor
      if (context && context.anchorNode) {
        anchor = context.anchorNode
      }
      if (this.browser.loading.has(a.id)) {
        this.browser.setResultNode(a)
        historyPushState(a.keyspace, a.type, a.id)
      }
      this.statusbar.removeLoading(a.id)
      this.statusbar.addMsg('loaded', a.type, a.id)
      this.call('addNode', {id: a.id, type: a.type, keyspace: a.keyspace, anchor})
    })
    this.dispatcher.on('resultTransactionForBrowser', ({result}) => {
      this.browser.setTransaction(result)
      historyPushState(result.keyspace, 'transaction', result.txHash)
      this.statusbar.removeLoading(result.txHash)
      this.statusbar.addMsg('loaded', 'transaction', result.txHash)
    })
    this.dispatcher.on('resultLabelForBrowser', ({result, context}) => {
      this.browser.setLabel(result)
      historyPushState(null, 'label', result.label)
      this.statusbar.removeLoading(context)
      this.statusbar.addMsg('loaded', 'label', result.label)
      this.call('initTagsTable', {id: result.label, type: 'label', index: 0})
    })
    this.dispatcher.on('resultBlockForBrowser', ({result}) => {
      this.browser.setBlock(result)
      historyPushState(result.keyspace, 'block', result.height)
      this.statusbar.removeLoading(result.height)
      this.statusbar.addMsg('loaded', 'block', result.height)
    })
    this.dispatcher.on('searchresult', ({context, result}) => {
      let search = context.isInDialog ? this.menu.search : this.search
      if (!search) return
      search.hideLoading()
      search.setResult(context.term, result)
    })
    this.dispatcher.on('searchresultLabels', ({context, result}) => {
      let search = context.isInDialog ? this.menu.search : this.search
      logger.debug('search', search)
      if (!search) return
      search.hideLoading()
      search.setResultLabels(context.term, result)
    })
    this.dispatcher.on('selectNode', ([type, nodeId]) => {
      logger.debug('selectNode', type, nodeId)
      let o = this.store.get(nodeId[2], type, nodeId[0])
      if (!o) {
        throw new Error(`selectNode: ${nodeId} of type ${type} not found in store`)
      }
      historyPushState(o.keyspace, o.type, o.id)
      if (type === 'address') {
        this.browser.setAddress(o)
      } else if (type === 'cluster') {
        this.browser.setCluster(o)
      }
      this.graph.selectNode(type, nodeId)
    })
    // user clicks address in a table
    this.dispatcher.on('clickAddress', ({address, keyspace}) => {
      if (supportedKeyspaces.indexOf(keyspace) === -1) return
      this.statusbar.addLoading(address)
      this.mapResult(this.rest.node(keyspace, {id: address, type: 'address'}), 'resultNode', address)
    })
    // user clicks label in a table
    this.dispatcher.on('clickLabel', ({label, keyspace}) => {
      this.statusbar.addLoading(label)
      this.mapResult(this.rest.label(label), 'resultLabelForBrowser', label)
    })
    this.dispatcher.on('deselect', () => {
      this.browser.deselect()
      this.config.hide()
      this.graph.deselect()
    })
    this.dispatcher.on('clickTransaction', ({txHash, keyspace}) => {
      this.browser.loading.add(txHash)
      this.statusbar.addLoading(txHash)
      this.mapResult(this.rest.transaction(keyspace, txHash), 'resultTransactionForBrowser', txHash)
    })
    this.dispatcher.on('clickBlock', ({height, keyspace}) => {
      this.browser.loading.add(height)
      this.statusbar.addLoading(height)
      this.mapResult(this.rest.block(keyspace, height), 'resultBlockForBrowser', height)
    })

    this.dispatcher.on('loadAddresses', ({keyspace, params, nextPage, request, drawCallback}) => {
      this.statusbar.addMsg('loading', 'addresses')
      this.mapResult(this.rest.addresses(keyspace, {params, nextPage, pagesize: request.length}), 'resultAddresses', {page: nextPage, request, drawCallback})
    })
    this.dispatcher.on('resultAddresses', ({context, result}) => {
      this.statusbar.addMsg('loaded', 'addresses')
      this.browser.setResponse({...context, result})
    })
    this.dispatcher.on('loadTransactions', ({keyspace, params, nextPage, request, drawCallback}) => {
      this.statusbar.addMsg('loading', 'transactions')
      this.mapResult(this.rest.transactions(keyspace, {params, nextPage, pagesize: request.length}), 'resultTransactions', {page: nextPage, request, drawCallback})
    })
    this.dispatcher.on('resultTransactions', ({context, result}) => {
      this.statusbar.addMsg('loaded', 'transactions')
      this.browser.setResponse({...context, result})
    })
    this.dispatcher.on('loadTags', ({keyspace, params, nextPage, request, drawCallback}) => {
      this.statusbar.addMsg('loading', 'tags')
      this.mapResult(this.rest.tags(keyspace, {id: params[0], type: params[1], nextPage, pagesize: request.length}), 'resultTagsTable', {page: nextPage, request, drawCallback})
    })
    this.dispatcher.on('resultTagsTable', ({context, result}) => {
      this.browser.setResponse({...context, result})
    })
    this.dispatcher.on('initTransactionsTable', (request) => {
      this.browser.initTransactionsTable(request)
    })
    this.dispatcher.on('initBlockTransactionsTable', (request) => {
      this.browser.initBlockTransactionsTable(request)
    })
    this.dispatcher.on('initAddressesTable', (request) => {
      this.browser.initAddressesTable(request)
    })
    this.dispatcher.on('initAddressesTableWithCluster', ({id, keyspace}) => {
      let cluster = this.store.get(keyspace, 'cluster', id)
      if (!cluster) return
      this.browser.setCluster(cluster)
      this.browser.initAddressesTable({index: 0, id, type: 'cluster'})
    })
    this.dispatcher.on('initTagsTable', (request) => {
      this.browser.initTagsTable(request)
    })
    this.dispatcher.on('initIndegreeTable', (request) => {
      this.browser.initNeighborsTable(request, false)
    })
    this.dispatcher.on('initOutdegreeTable', (request) => {
      this.browser.initNeighborsTable(request, true)
    })
    this.dispatcher.on('initNeighborsTableWithNode', ({id, keyspace, type, isOutgoing}) => {
      let node = this.store.get(keyspace, type, id)
      if (!node) return
      if (type === 'address') {
        this.browser.setAddress(node)
      } else if (type === 'cluster') {
        this.browser.setCluster(node)
      }
      this.browser.initNeighborsTable({id, keyspace, type, index: 0}, isOutgoing)
    })
    this.dispatcher.on('initTxInputsTable', (request) => {
      this.browser.initTxAddressesTable(request, false)
    })
    this.dispatcher.on('initTxOutputsTable', (request) => {
      this.browser.initTxAddressesTable(request, true)
    })
    this.dispatcher.on('loadNeighbors', ({keyspace, params, nextPage, request, drawCallback}) => {
      let id = params[0]
      let type = params[1]
      let isOutgoing = params[2]
      this.mapResult(this.rest.neighbors(keyspace, id, type, isOutgoing, request.length, nextPage), 'resultNeighbors', {page: nextPage, request, drawCallback})
    })
    this.dispatcher.on('resultNeighbors', ({context, result}) => {
      this.browser.setResponse({...context, result})
    })
    this.dispatcher.on('selectNeighbor', (data) => {
      logger.debug('selectNeighbor', data)
      if (!data.id || !data.nodeType || !data.keyspace) return
      let focusNode = this.browser.getCurrentNode()
      let anchorNode = this.graph.selectedNode
      let isOutgoing = this.browser.isShowingOutgoingNeighbors()
      let o = this.store.get(data.keyspace, data.nodeType, data.id)
      let context =
        {
          data,
          focusNode:
            {
              id: focusNode.id,
              type: focusNode.type,
              keyspace: data.keyspace,
              linkData: {...data},
              isOutgoing: isOutgoing
            }
        }
      if (anchorNode) {
        context['anchorNode'] = {nodeId: anchorNode.id, isOutgoing}
      }
      if (!o) {
        this.statusbar.addLoading(data.id)
        this.mapResult(this.rest.node(data.keyspace, {id: data.id, type: data.nodeType}), 'resultNode', context)
      } else {
        this.call('resultNode', { context, result: o })
      }
    })
    this.dispatcher.on('selectAddress', (data) => {
      logger.debug('selectAdress', data)
      if (!data.address || !data.keyspace) return
      this.mapResult(this.rest.node(data.keyspace, {id: data.address, type: 'address'}), 'resultNode', data.address)
    })
    this.dispatcher.on('addNode', ({id, type, keyspace, anchor}) => {
      this.graph.adding.add(id)
      this.statusbar.addLoading(id)
      this.call('addNodeCont', {context: {stage: 1, id, type, keyspace, anchor}, result: null})
    })
    this.dispatcher.on('addNodeCont', ({context, result}) => {
      let anchor = context.anchor
      let keyspace = context.keyspace
      if (context.stage === 1 && context.type && context.id) {
        let a = this.store.get(context.keyspace, context.type, context.id)
        if (!a) {
          this.statusbar.addMsg('loading', context.type, context.id)
          this.mapResult(this.rest.node(keyspace, {type: context.type, id: context.id}), 'addNodeCont', {stage: 2, keyspace, anchor})
        } else {
          this.call('addNodeCont', {context: {stage: 2, keyspace, anchor}, result: a})
        }
      } else if (context.stage === 2 && result) {
        let o = this.store.add(result)
        this.statusbar.addMsg('loaded', o.type, o.id)
        if (anchor && anchor.isOutgoing === false) {
          // incoming neighbor node
          this.store.linkOutgoing(o.id, anchor.nodeId[0], o.keyspace)
        }
        if (!this.graph.adding.has(o.id)) return
        logger.debug('cluster', o.cluster)
        if (o.type === 'address' && !o.cluster) {
          this.statusbar.addMsg('loadingClusterFor', o.id)
          this.mapResult(this.rest.clusterForAddress(keyspace, o.id), 'addNodeCont', {stage: 3, addressId: o.id, keyspace, anchor})
        } else {
          this.call('addNodeCont', {context: {stage: 4, id: o.id, type: o.type, keyspace, anchor}})
        }
      } else if (context.stage === 3 && context.addressId) {
        if (!this.graph.adding.has(context.addressId)) return
        let resultCopy = {...result}
        // seems there exist addresses without cluster ...
        // so mockup cluster with the address id
        if (!resultCopy.cluster) {
          resultCopy.cluster = 'mockup' + context.addressId
          resultCopy.mockup = true
          this.statusbar.addMsg('noClusterFor', context.addressId)
        } else {
          this.statusbar.addMsg('loadedClusterFor', context.addressId)
        }
        this.store.add({...resultCopy, forAddresses: [context.addressId]})
        this.call('addNodeCont', {context: {stage: 4, id: context.addressId, type: 'address', keyspace, anchor}})
      } else if (context.stage === 4 && context.id && context.type) {
        let backCall = {msg: 'addNodeCont', data: {context: { ...context, stage: 5 }}}
        let o = this.store.get(context.keyspace, context.type, context.id)
        if (context.type === 'cluster') {
          this.call('excourseLoadDegree', {context: {backCall, id: o.id, type: 'cluster', keyspace}})
        } else if (context.type === 'address') {
          if (o.cluster && !o.cluster.mockup) {
            this.call('excourseLoadDegree', {context: {backCall, id: o.cluster.id, type: 'cluster', keyspace}})
          } else {
            this.call(backCall.msg, backCall.data)
          }
        }
      } else if (context.stage === 5 && context.id && context.type) {
        let o = this.store.get(context.keyspace, context.type, context.id)
        if (!o.tags) {
          this.statusbar.addMsg('loadingTagsFor', o.type, o.id)
          this.mapResult(this.rest.tags(keyspace, {id: o.id, type: o.type}), 'resultTags', {id: o.id, type: o.type, keypspace: o.keyspace})
        }
        this.graph.add(o, context.anchor)
        this.browser.setUpdate('tables_with_addresses')
        this.statusbar.removeLoading(o.id)
      }
    })
    this.dispatcher.on('excourseLoadDegree', ({context, result}) => {
      let keyspace = context.keyspace
      if (!context.stage) {
        let o = this.store.get(context.keyspace, context.type, context.id)
        if (o.inDegree >= degreeThreshold) {
          this.call('excourseLoadDegree', {context: { ...context, stage: 2 }})
          return
        }
        this.statusbar.addMsg('loadingNeighbors', o.id, o.type, false)
        this.mapResult(this.rest.neighbors(keyspace, o.id, o.type, false, degreeThreshold), 'excourseLoadDegree', { ...context, stage: 2 })
      } else if (context.stage === 2) {
        this.statusbar.addMsg('loadedNeighbors', context.id, context.type, false)
        let o = this.store.get(context.keyspace, context.type, context.id)
        if (result && result.neighbors) {
          // add the node in context to the outgoing set of incoming relations
          result.neighbors.forEach((neighbor) => {
            if (neighbor.nodeType !== o.type) return
            this.store.linkOutgoing(neighbor.id, o.id, neighbor.keyspace, neighbor)
          })
          // this.storeRelations(result.neighbors, o, o.keyspace, false)
        }
        if (o.outDegree >= degreeThreshold || o.outDegree === o.outgoing.size()) {
          this.call(context.backCall.msg, context.backCall.data)
          return
        }
        this.statusbar.addMsg('loadingNeighbors', o.id, o.type, true)
        this.mapResult(this.rest.neighbors(keyspace, o.id, o.type, true, degreeThreshold), 'excourseLoadDegree', {...context, stage: 3})
      } else if (context.stage === 3) {
        let o = this.store.get(context.keyspace, context.type, context.id)
        this.statusbar.addMsg('loadedNeighbors', context.id, context.type, true)
        if (result && result.neighbors) {
          // add outgoing relations to the node in context
          result.neighbors.forEach((neighbor) => {
            if (neighbor.nodeType !== o.type) return
            this.store.linkOutgoing(o.id, neighbor.id, o.keyspace, neighbor)
          })
          // this.storeRelations(result.neighbors, o, o.keyspace, true)
        }
        this.call(context.backCall.msg, context.backCall.data)
      }
    })
    this.dispatcher.on('resultTags', ({context, result}) => {
      let o = this.store.get(context.keyspace, context.type, context.id)
      this.statusbar.addMsg('loadedTagsFor', o.type, o.id)
      o.tags = result || []
      let nodes = null
      if (context.type === 'address') {
        nodes = this.graph.addressNodes
      }
      if (context.type === 'cluster') {
        nodes = this.graph.clusterNodes
      }
      if (!nodes) return
      nodes.each((node) => { if (node.id[0] == context.id) node.setUpdate(true) }) // eslint-disable-line eqeqeq
    })
    this.dispatcher.on('loadEgonet', ({id, type, keyspace, isOutgoing, limit}) => {
      this.statusbar.addLoading(`neighbors of ${type} ${id[0]}`)
      this.statusbar.addMsg('loadingNeighbors', id, type, isOutgoing)
      this.mapResult(this.rest.neighbors(keyspace, id[0], type, isOutgoing, limit), 'resultEgonet', {id, type, isOutgoing, keyspace})
    })
    this.dispatcher.on('resultEgonet', ({context, result}) => {
      let a = this.store.get(context.keyspace, context.type, context.id[0])
      this.statusbar.addMsg('loadedNeighbors', context.id[0], context.type, context.isOutgoing)
      this.statusbar.removeLoading(`neighbors of ${context.type} ${context.id[0]}`)
      result.neighbors.forEach((node) => {
        if (node.id === context.id[0] || node.nodeType !== context.type) return
        let anchor = {
          nodeId: context.id,
          nodeType: context.type,
          isOutgoing: context.isOutgoing
        }
        if (context.isOutgoing === true) {
          this.store.linkOutgoing(a.id, node.id, a.keyspace, node)
        } else if (context.isOutgoing === false) {
          this.store.linkOutgoing(node.id, a.id, node.keyspace, node)
        }
        this.call('addNode', {id: node.id, type: node.nodeType, keyspace: node.keyspace, anchor})
      })
    })
    this.dispatcher.on('loadClusterAddresses', ({id, keyspace, limit}) => {
      this.statusbar.addMsg('loadingClusterAddresses', id, limit)
      this.statusbar.addLoading('addresses of cluster ' + id[0])
      this.mapResult(this.rest.clusterAddresses(keyspace, id[0], limit), 'resultClusterAddresses', {id, keyspace})
    })
    this.dispatcher.on('removeClusterAddresses', id => {
      this.graph.removeClusterAddresses(id)
      this.browser.setUpdate('tables_with_addresses')
    })
    this.dispatcher.on('resultClusterAddresses', ({context, result}) => {
      let id = context && context.id
      let keyspace = context && context.keyspace
      let addresses = []
      this.statusbar.removeLoading('addresses of cluster ' + id[0])
      result.addresses.forEach((address) => {
        let copy = {...address, toCluster: id[0]}
        let a = this.store.add(copy)
        addresses.push(a)
        if (!a.tags) {
          let request = {id: a.id, type: 'address', keyspace}
          this.mapResult(this.rest.tags(keyspace, request), 'resultTags', request)
        }
      })
      this.statusbar.addMsg('loadedClusterAddresses', id, addresses.length)
      this.graph.setResultClusterAddresses(id, addresses)
      this.browser.setUpdate('tables_with_addresses')
    })
    this.dispatcher.on('changeClusterLabel', (labelType) => {
      this.config.setClusterLabel(labelType)
      this.graph.setClusterLabel(labelType)
    })
    this.dispatcher.on('changeAddressLabel', (labelType) => {
      this.config.setAddressLabel(labelType)
      this.graph.setAddressLabel(labelType)
    })
    this.dispatcher.on('changeCurrency', (currency) => {
      this.browser.setCurrency(currency)
      this.graph.setCurrency(currency)
      this.layout.setCurrency(currency)
    })
    this.dispatcher.on('changeTxLabel', (type) => {
      this.graph.setTxLabel(type)
      this.config.setTxLabel(type)
    })
    this.dispatcher.on('removeNode', ([nodeType, nodeId]) => {
      this.statusbar.addMsg('removeNode', nodeType, nodeId[0])
      this.graph.remove(nodeType, nodeId)
      this.browser.setUpdate('tables_with_addresses')
    })
    this.dispatcher.on('inputNotes', ({id, type, keyspace, note}) => {
      let o = this.store.get(keyspace, type, id)
      o.notes = note
      let nodes
      if (type === 'address') {
        nodes = this.graph.addressNodes
      } else if (type === 'cluster') {
        nodes = this.graph.clusterNodes
      }
      nodes.each((node) => {
        if (node.data.id === id) {
          node.setUpdate('label')
        }
      })
    })
    this.dispatcher.on('toggleConfig', () => {
      this.config.toggleConfig()
    })
    this.dispatcher.on('stats', () => {
      this.mapResult(this.rest.stats(), 'receiveStats')
    })
    this.dispatcher.on('receiveStats', ({context, result}) => {
      this.keyspaces = Object.keys(result)
      this.landingpage.setStats({...result})
      this.search.setStats({...result})
    })
    this.dispatcher.on('noteDialog', ({x, y, node}) => {
      this.menu.showNodeDialog(x, y, {dialog: 'note', node})
      this.call('selectNode', [node.data.type, node.id])
    })
    this.dispatcher.on('searchNeighborsDialog', ({x, y, id, type, isOutgoing}) => {
      this.menu.showNodeDialog(x, y, {dialog: 'search', id, type, isOutgoing})
      this.call('selectNode', [type, id])
    })
    this.dispatcher.on('changeSearchCriterion', criterion => {
      this.menu.setSearchCriterion(criterion)
    })
    this.dispatcher.on('changeSearchCategory', category => {
      this.menu.setSearchCategory(category)
    })
    this.dispatcher.on('hideContextmenu', () => {
      this.menu.hideMenu()
    })
    this.dispatcher.on('new', () => {
      if (this.isReplaying) return
      if (!this.promptUnsavedWork('start a new graph')) return
      this.createComponents()
    })
    this.dispatcher.on('save', (stage) => {
      if (this.isReplaying) return
      if (!stage) {
        // update status bar before starting serializing
        this.statusbar.addMsg('saving')
        this.call('save', true)
        return
      }
      let filename = moment().format('YYYY-MM-DD HH-mm-ss') + '.gs'
      this.statusbar.addMsg('saved', filename)
      this.download(filename, this.serialize())
    })
    this.dispatcher.on('exportSvg', () => {
      if (this.isReplaying) return
      let classMap = map()
      let rules = document.styleSheets[0].cssRules
      for (let i = 0; i < rules.length; i++) {
        let selectorText = rules[i].selectorText
        let cssText = rules[i].cssText
        if (!selectorText || !selectorText.startsWith('svg')) continue
        let s = selectorText.replace('.', '').replace('svg', '').trim()
        classMap.set(s, cssText.split('{')[1].replace('}', ''))
      }
      let svg = this.graph.getSvg()
      // replace classes by inline styles
      svg = svg.replace(new RegExp('class="(.+?)"', 'g'), (_, classes) => {
        logger.debug('classes', classes)
        let repl = classes.split(' ')
          .map(cls => classMap.get(cls) || '')
          .join('')
        logger.debug('repl', repl)
        if (repl.trim() === '') return ''
        return 'style="' + repl.replace(/"/g, '\'').replace('"', '\'') + '"'
      })
      // replace double quotes and quot (which was created by innerHTML)
      svg = svg.replace(new RegExp('style="(.+?)"', 'g'), (_, style) => 'style="' + style.replace(/&quot;/g, '\'') + '"')
      // merge double style definitions
      svg = svg.replace(new RegExp('style="([^"]+?)"([^>]+?)style="([^"]+?)"', 'g'), 'style="$1$3" $2')
      let filename = moment().format('YYYY-MM-DD HH-mm-ss') + '.svg'
      this.download(filename, svg)
    })
    this.dispatcher.on('load', () => {
      if (this.isReplaying) return
      if (this.promptUnsavedWork('load another file')) {
        this.layout.triggerFileLoad()
      }
    })
    this.dispatcher.on('loadFile', (params) => {
      let data = params[0]
      let filename = params[1]
      let stage = params[2]
      if (!stage) {
        this.statusbar.addMsg('loadFile', filename)
        this.call('loadFile', [data, filename, true])
        return
      }
      this.statusbar.addMsg('loadedFile', filename)
      this.deserialize(data)
    })
    this.dispatcher.on('showLogs', () => {
      this.statusbar.show()
    })
    this.dispatcher.on('hideLogs', () => {
      this.statusbar.hide()
    })
    this.dispatcher.on('moreLogs', () => {
      this.statusbar.moreLogs()
    })
    this.dispatcher.on('toggleErrorLogs', () => {
      this.statusbar.toggleErrorLogs()
    })
    this.dispatcher.on('gohome', () => {
      logger.debug('going home')
      this.showLandingpage = true
      historyPushState()
      this.browser.destroyComponentsFrom(0)
      this.landingpage.setUpdate(true)
      this.layout.setUpdate(true)
      this.render()
    })
    this.dispatcher.on('sortClusterAddresses', ({cluster, property}) => {
      this.graph.sortClusterAddresses(cluster, property)
    })
    this.dispatcher.on('dragNode', ({id, type, dx, dy}) => {
      this.graph.dragNode(id, type, dx, dy)
    })
    this.dispatcher.on('dragNodeEnd', ({id, type}) => {
      this.graph.dragNodeEnd(id, type)
    })
    this.dispatcher.on('changeSearchDepth', value => {
      this.menu.setSearchDepth(value)
    })
    this.dispatcher.on('changeSearchBreadth', value => {
      this.menu.setSearchBreadth(value)
    })
    this.dispatcher.on('searchNeighbors', params => {
      logger.debug('search params', params)
      this.statusbar.addSearching(params)
      this.mapResult(this.rest.searchNeighbors(params), 'resultSearchNeighbors', params)
      this.menu.hideMenu()
    })
    this.dispatcher.on('resultSearchNeighbors', ({result, context}) => {
      this.statusbar.removeSearching(context)
      let count = 0
      let add = (anchor, paths) => {
        if (!paths) {
          count++
          return
        }
        paths.forEach(pathnode => {
          pathnode.node.keyspace = result.keyspace

          // store relations
          let node = this.store.add(pathnode.node)
          let src = context.isOutgoing ? anchor.nodeId[0] : node.id
          let dst = context.isOutgoing ? node.id : anchor.nodeId[0]
          this.store.linkOutgoing(src, dst, result.keyspace, pathnode.relation)

          // fetch all relations
          let backCall = {msg: 'redrawGraph', data: null}
          this.call('excourseLoadDegree', {context: {backCall, id: node.id, type: context.type, keyspace: result.keyspace}})

          let parent = this.graph.add(node, anchor)
          // link addresses to cluster and add them (if any returned due of 'addresses' search criterion)
          pathnode.matchingAddresses.forEach(address => {
            address.cluster = pathnode.node.cluster
            let a = this.store.add(address)
            // anchor the address to its cluster
            this.graph.add(a, {nodeId: parent.id, nodeType: 'cluster'})
          })
          add({nodeId: parent.id, isOutgoing: context.isOutgoing}, pathnode.paths)
        })
      }
      add({nodeId: context.id, isOutgoing: context.isOutgoing}, result.paths)
      this.statusbar.addMsg('searchResult', count, context.params.category)
      this.browser.setUpdate('tables_with_addresses')
    })
    this.dispatcher.on('redrawGraph', () => {
      this.graph.setUpdate('layers')
    })
    this.dispatcher.on('createSnapshot', () => {
      this.graph.createSnapshot()
      this.layout.disableButton('undo', !this.graph.thereAreMorePreviousSnapshots())
      this.layout.disableButton('redo', !this.graph.thereAreMoreNextSnapshots())
    })
    this.dispatcher.on('undo', () => {
      this.graph.loadPreviousSnapshot(this.store)
      this.browser.setUpdate('tables_with_addresses')
      this.layout.disableButton('undo', !this.graph.thereAreMorePreviousSnapshots())
      this.layout.disableButton('redo', !this.graph.thereAreMoreNextSnapshots())
    })
    this.dispatcher.on('redo', () => {
      this.graph.loadNextSnapshot(this.store)
      this.browser.setUpdate('tables_with_addresses')
      this.layout.disableButton('undo', !this.graph.thereAreMorePreviousSnapshots())
      this.layout.disableButton('redo', !this.graph.thereAreMoreNextSnapshots())
    })
    this.dispatcher.on('disableUndoRedo', () => {
      this.layout.disableButton('undo', true)
      this.layout.disableButton('redo', true)
    })
    this.dispatcher.on('toggleSearchTable', () => {
      this.browser.toggleSearchTable()
    })
    this.dispatcher.on('toggleLegend', () => {
      this.config.setCategoryColors(this.graph.getCategoryColors())
      this.config.toggleLegend()
    })
    this.dispatcher.on('downloadTable', () => {
      if (this.isReplaying) return
      let table = this.browser.content[1]
      if (!table) return
      let filename
      let request
      if (table instanceof NeighborsTable) {
        let params = table.getParams()
        request = this.rest.neighbors(params.keyspace, params.id, params.type, params.isOutgoing, 0, 0, true)
        filename = (params.isOutgoing ? 'outgoing' : 'incoming') + ` neighbors of ${params.type} ${params.id} (${params.keyspace.toUpperCase()})`
      } else if (table instanceof TagsTable) {
        let params = table.getParams()
        request = this.rest.tags(params.keyspace, params, true)
        filename = `tags of ${params.type} ${params.id} (${params.keyspace.toUpperCase()})`
      } else if (table instanceof TransactionsTable || table instanceof BlockTransactionsTable) {
        let params = table.getParams()
        request = this.rest.transactions(params.keyspace, {params: [params.id, params.type]}, true)
        filename = `transactions of ${params.type} ${params.id} (${params.keyspace.toUpperCase()})`
      }
      if (request) {
        this.mapResult(request, 'receiveCSV', filename + '.csv')
      }
    })
    this.dispatcher.on('receiveCSV', ({context, result}) => {
      FileSaver.saveAs(result, context)
    })
    this.dispatcher.on('addAllToGraph', () => {
      let table = this.browser.content[1]
      if (!table) return
      table.data.forEach(row => {
        if (!row.keyspace) {
          if (row.currency) row.keyspace = row.currency.toLowerCase()
          else row.keyspace = table.keyspace
        }
        this.call(table.selectMessage, row)
      })
    })
    this.dispatcher.on('tooltip', (type) => {
      this.statusbar.showTooltip(type)
    })
    this.dispatcher.on('hideTooltip', (type) => {
      this.statusbar.showTooltip('')
    })
    this.dispatcher.on('changeLocale', (locale) => {
      moment.locale(locale)
      numeral.locale(locale)
      this.locale = locale
      this.config.setLocale(locale)
      this.browser.setUpdate('locale')
      this.graph.setUpdate('layers')
    })
    window.onhashchange = (e) => {
      let params = fromURL(e.newURL, this.keyspaces)
      logger.debug('hashchange', e, params)
      if (!params) return
      this.paramsToCall(params)
    }
    let that = this
    window.addEventListener('beforeunload', function (evt) {
      if (IS_DEV) return // eslint-disable-line no-undef
      if (!that.showLandingpage) {
        let message = 'You are about to leave the site. Your work will be lost. Sure?'
        if (typeof evt === 'undefined') {
          evt = window.event
        }
        if (evt) {
          evt.returnValue = message
        }
        return message
      }
    })
    this.call('stats')
    let initParams = fromURL(window.location.href, this.keyspaces)
    if (initParams.id) {
      this.paramsToCall(initParams)
    }
  }
  storeRelations (relations, anchor, keyspace, isOutgoing) {
    relations.forEach((relation) => {
      if (relation.nodeType !== anchor.type) return
      let src = isOutgoing ? relation.id : anchor.id
      let dst = isOutgoing ? anchor.id : relation.id
      this.store.linkOutgoing(src, dst, keyspace, relation)
    })
  }
  promptUnsavedWork (msg) {
    if (!this.isDirty) return true
    return confirm('You have unsaved changes. Do you really want to ' + msg + '?') // eslint-disable-line no-undef
  }
  paramsToCall ({id, type, keyspace}) {
    this.call('clickSearchResult', {id, type, keyspace})
  }
  createComponents () {
    this.isDirty = false
    this.store = new Store()
    this.browser = new Browser(this.call, defaultCurrency, this.keyspaces)
    this.config = new Config(this.call, defaultLabelType, defaultTxLabel, this.locale)
    this.menu = new Menu(this.call, this.keyspaces)
    this.graph = new NodeGraph(this.call, defaultLabelType, defaultCurrency, defaultTxLabel)
    this.browser.setNodeChecker(this.graph.getNodeChecker())
    this.search = new Search(this.call, this.keyspaces)
    this.layout = new Layout(this.call, this.browser, this.graph, this.config, this.menu, this.search, this.statusbar, defaultCurrency)
    this.layout.disableButton('undo', !this.graph.thereAreMorePreviousSnapshots())
    this.layout.disableButton('redo', !this.graph.thereAreMoreNextSnapshots())
    this.landingpage = new Landingpage(this.call, this.search, this.keyspaces)
  }
  compress (data) {
    return new Uint32Array(
      pack(
        // convert to base64 (utf-16 safe)
        Base64.encode(
          JSON.stringify(data)
        )
      )
    ).buffer
  }
  decompress (data) {
    return JSON.parse(
      Base64.decode(
        unpack(
          [...new Uint32Array(data)]
        )
      )
    )
  }
  serialize () {
    return this.compress([
      VERSION, // eslint-disable-line no-undef
      this.store.serialize(),
      this.graph.serialize(),
      this.config.serialize(),
      this.layout.serialize()
    ])
  }
  deserialize (buffer) {
    let data = this.decompress(buffer)
    this.createComponents()
    this.store.deserialize(data[0], data[1])
    this.graph.deserialize(data[0], data[2], this.store)
    this.config.deserialize(data[0], data[3])
    this.layout.deserialize(data[0], data[4])
    this.layout.setUpdate(true)
  }
  download (filename, buffer) {
    var blob = new Blob([buffer], {type: 'application/octet-stream'}) // eslint-disable-line no-undef
    FileSaver.saveAs(blob, filename)
  }
  mapResult (promise, msg, context) {
    let onSuccess = result => {
      this.call(msg, {context, result})
    }
    let onReject = error => {
      this.call('fetchError', {context, msg, error})
    }
    if (this.isReplaying) {
      onSuccess = () => {}
      onReject = () => {}
    }
    return promise.then(onSuccess, onReject)
  }
  render (root) {
    if (root) this.root = root
    if (!this.root) throw new Error('root not defined')
    if (this.showLandingpage) {
      return this.landingpage.render(this.root)
    }
    logger.debug('model render')
    logger.debug('model', this)
    return this.layout.render(this.root)
  }
  replay () {
    this.rest.disable()
    logger.debug('replay')
    this.isReplaying = true
    this.dispatcher.replay()
    this.isReplaying = false
    this.rest.enable()
  }
}
