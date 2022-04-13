import { Observable } from 'lib0/observable.js'

import Olm from 'olm'

const NUM_ONE_TIME_KEYS = 10
const FILE_PREFIX = 'drchannel.'

export default class DoubleRatchetFileStorage extends Observable {
  constructor (storageAdapter, actorId, handshakeMessage, kvGet, kvSet) {
    super()
    this.storageAdapter = storageAdapter
    this.actorId = actorId
    this.incomingQueue = []
    this.outgoingQueues = {}
    this.unpushedQueues = {}
    this.alreadySeenMessageCollection = {}
    this.published = {}
    this.account = null
    this.sessions = {}
    this.stateloaded = false
    this.synced = false
    this.peers = {}
    this.handshakeMessage = handshakeMessage
    this._kvGet = kvGet
    this._kvSet = kvSet
  }

  async loadState() {
    if (!this.stateloaded)
    {
      await Olm.init()
    }

    const pub = await this._kvGet("published")
    if (pub)
    {
      const pubObj = JSON.parse(pub)
      for (let pubMap in pubObj)
      {
	const unsortedArray = pubObj[pubMap]
	const sortedArray = unsortedArray.sort(([key1, val1], [key2, val2]) => (key1 - key2))
	const sortedMap = new Map(sortedArray)
	this.published[pubMap] = sortedMap
      }
    }
    const iq = await this._kvGet('incomingQueue')
    if (iq)
    {
      this.incomingQueue = JSON.parse(iq)
    }
    const oq = await this._kvGet('outgoingQueues')
    if (oq)
    {
      this.outgoingQueues = JSON.parse(oq)
    }
    const unpushedQueues = await this._kvGet('unpushedQueues')
    if (unpushedQueues)
    {
      this.unpushedQueues = JSON.parse(unpushedQueues)
    }
    const lastSync = await this._kvGet('alreadySeenMessageCollection')
    if (lastSync)
    {
      this.alreadySeenMessageCollection = JSON.parse(lastSync)
    }
    const acct = await this._kvGet('account')
    this.account = new Olm.Account();
    if (acct)
    {
      this.account.unpickle('fixed_insecure_key', acct)
    }
    else
    {
      this.account.create()
    }
    const sessions = await this._kvGet('sessions')
    if (sessions)
    {
      const sessionList = JSON.parse(sessions)
      for (let session in sessionList)
      {
	const sessionObj = new Olm.Session()
	sessionObj.unpickle('fixed_insecure_key', sessionList[session])
	this.sessions[session] = sessionObj
      }
    }
    const peers = await this._kvGet('peers')
    if (peers)
    {
      this.peers = JSON.parse(peers)
    }

    this.stateloaded = true
  }

  async saveState() {
    if (!this.stateloaded)
    {
      throw 'Tried to save state without loading it first'
    }
    const published = {}
    for (let actorId in this.published)
    {
      published[actorId] = Array.from(this.published[actorId], ([name, value]) => ([name, value]))
    }
    await this._kvSet('published', JSON.stringify(published))
    await this._kvSet('incomingQueue', JSON.stringify(this.incomingQueue))
    await this._kvSet('outgoingQueues', JSON.stringify(this.outgoingQueues))
    await this._kvSet('unpushedQueues', JSON.stringify(this.unpushedQueues))
    await this._kvSet('alreadySeenMessageCollection', JSON.stringify(this.alreadySeenMessageCollection))
    await this._kvSet('account', this.account.pickle('fixed_insecure_key'))
    const saveSessions = {}
    for (let session in this.sessions)
    {
      saveSessions[session] = this.sessions[session].pickle('fixed_insecure_key')
    }
    await this._kvSet('sessions', JSON.stringify(saveSessions))
    await this._kvSet('peers', JSON.stringify(this.peers))
  }

  async syncIncoming () {
    if (!this.stateloaded)
    {
      throw 'Tried to sync without loading state first'
    }
    const fileList = await this.storageAdapter.getFileList(FILE_PREFIX)
    /* First fetch 3 types of files, id files, one-time-key files, and message files (addressed to our actorId) */
    for (let f in fileList)
    {
      if (fileList[f].name.endsWith('.id'))
      {
	const parts = fileList[f].name.split('.')
	/* Don't overwrite if we've already seen this actor id */
	if (parts[1] != this.actorId && !(parts[1] in this.peers))
	{
	  const id_key = await this.storageAdapter.getFile(fileList[f].name)
	  this.peers[parts[1]] = { key: id_key.contents.toString(), state: "unverified", oneTimeKeys: [], seenIndex: -1, handshake: null, messageFilesSeen: {}, decryptionFailures: 0, encryptionFailures: 0, currentIndex: 0 }
	}
      }
    }

    /* Clear our lists of one time keys so we can rebuild them, but cache the keys themselves so we don't have to re-fetch every key */
    const keyCache = {}
    for (let actorId in this.peers)
    {
      for (let i in this.peers[actorId].oneTimeKeys)
      {
	keyCache[this.peers[actorId].oneTimeKeys[i].filename] = this.peers[actorId].oneTimeKeys[i].key
      }
      this.peers[actorId].oneTimeKeys = []
    }

    /* Repopulate lists of one time keys */
    for (let f in fileList)
    {
      if (fileList[f].name.endsWith('.otk'))
      {
	const parts = fileList[f].name.split('.')
	if (parts[1] in this.peers)
	{
	  let otk = null
	  if (fileList[f].name in keyCache)
	  {
	    otk = keyCache[fileList[f].name]
	  }
	  else
	  {
	    const keyFile = await this.storageAdapter.getFile(fileList[f].name)
	    otk = keyFile.contents.toString()
	  }
	  this.peers[parts[1]].oneTimeKeys.push({filename: fileList[f].name, key: otk})
	}
      }
    }

    /* Now download any incoming messages */
    const currentMessages = []
    const existingFiles = {}
    const messageFilesScanned = []
    for (let f in fileList)
    {
      if (fileList[f].name.endsWith('.msg'))
      {
	const parts = fileList[f].name.split('.')
	if (parts[1] in this.peers && parts[2] == this.actorId.toString() && this.peers[parts[1]].messageFilesSeen[fileList[f].name] != fileList[f].uniqueId)
	{
	  messageFilesScanned.push(parts[1])
	  /* Only look at message files that are addressed to our actorId, from verified actors */
	  if (this.peers[parts[1]].state != "unverified")
	  {
	    const msgs = await this.storageAdapter.getFile(fileList[f].name)
	    const msgList = msgs.contents.toString().split(/\r?\n/).filter(e => e && (e[0] == "0" || e[0] == "1"))
	    for (let msg in msgList)
	    {
	      currentMessages.push({actorId: parts[1], type: parseInt(msgList[msg][0]), message: msgList[msg].slice(1), verified: true})
	      if (!(currentMessages[currentMessages.length-1].message in this.alreadySeenMessageCollection))
	      {
		this.incomingQueue.push(currentMessages[currentMessages.length-1])
		this.alreadySeenMessageCollection[currentMessages[currentMessages.length-1].message] = currentMessages[currentMessages.length-1].actorId
	      }
	    }
	  }
	  /* Also, carefully look at message files that are addressed to our actorId, from unverified actors */
	  else if (this.peers[parts[1]].state == "unverified")
	  {
	    const msgs = await this.storageAdapter.getFile(fileList[f].name)
	    const msgList = msgs.contents.toString().split(/\r?\n/).filter(e => e && e[0] == "0")
	    if (msgList.length > 0)
	    {
	      /* Only let 1 message of size less than 5k for unverified actors to avoid potentially filling up storage with spam */
	      if (msgList[0].length < 5000)
	      {
		currentMessages.push({actorId: parts[1], type: parseInt(msgList[0][0]), message: msgList[0].slice(1), verified: false})
		if (!(currentMessages[currentMessages.length-1].message in this.alreadySeenMessageCollection))
		{
		  this.incomingQueue.push(currentMessages[currentMessages.length-1])
		  this.alreadySeenMessageCollection[currentMessages[currentMessages.length-1].message] = currentMessages[currentMessages.length-1].actorId
		}
	      }
	    }
	  }
	  /* Now we mark that we've seen this version of this message file */
	  this.peers[parts[1]].messageFilesSeen[fileList[f].name] = fileList[f].uniqueId
	}
	existingFiles[fileList[f].uniqueId] = true
      }
    }

    /* Cleanup files that no longer exist from messageFilesSeen cache */
    for (let actorId in this.peers)
    {
      for (let msgFile in this.peers[actorId].messageFilesSeen)
      {
	if (!(this.peers[actorId].messageFilesSeen[msgFile] in existingFiles))
	{
	  delete this.peers[actorId].messageFilesSeen[msgFile]
	}
      }
    }

    /* Delete messages from already seen which have disappeared from any files */
    const messagesOnly = currentMessages.map(ob => ob.message)
    for (let m in this.alreadySeenMessageCollection)
    {
      /* Make sure we've actually scanned this message file during this run before deleting "rolled-off" history */
      if (messageFilesScanned.includes(this.alreadySeenMessageCollection[m]) && !messagesOnly.includes(m))
      {
	delete this.alreadySeenMessageCollection[m]
      }
    }
  }

  async processIncoming () {
    if (!this.stateloaded)
    {
      throw 'Tried to sync without loading state first'
    }
    const messagesToPop = []
    const decryptedMessages = []
    let changedPeers = false
    for (let m in this.incomingQueue)
    {
      const actorId = this.incomingQueue[m].actorId
      if (actorId in this.peers)
      {
	if (!(actorId in this.sessions))
	{
	  this.sessions[actorId] = new Olm.Session()
	  this.sessions[actorId].create_inbound_from(this.account, this.peers[actorId].key, this.incomingQueue[m].message)
	  this.outgoingQueues[actorId] = []
	  this.outgoingQueues[actorId].push({type: "handshake", body: this.handshakeMessage})
	}
	let plaintext = null
	try
	{
	  plaintext = this.sessions[actorId].decrypt(this.incomingQueue[m].type, this.incomingQueue[m].message)
	}
	catch (e)
	{
	  this.peers[actorId].decryptionFailures++
	  console.log("Failed decrypt incoming message with error: "+e.message)
	  changedPeers = true
	}
	if (plaintext)
	{
	  const msgObj = JSON.parse(plaintext)
	  /* Leave message on queue if it's not a handshake and the actor has not been verified */
	  if (this.peers[actorId].state == "verified" || msgObj.type == "handshake")
	  {
	    if (msgObj.type == "message")
	    {
	      decryptedMessages.push({from: actorId, body: msgObj.body})
	    }
	    else if (msgObj.type == "handshake")
	    {
	      this.peers[actorId].handshake = msgObj.body
	      changedPeers = true
	    }
	    if (msgObj.type == "seen")
	    {
	      this.peers[actorId].seenIndex = Math.max(msgObj.seenIndex, this.peers[actorId].seenIndex)
	    }
	    else
	    {
	      this.outgoingQueues[actorId].push({type: "seen", seenIndex: msgObj.index})
	    }
	    messagesToPop.push(m)
	  }
	}
      }
    }
    for (let i = messagesToPop.length - 1; i >= 0; i--)
    {
      this.incomingQueue.splice(messagesToPop[i], 1)
    }
    if (changedPeers)
    {
      this.emit('changedPeers', [this])
    }
    if (decryptedMessages.length > 0)
    {
      this.emit('messagesReceived', [decryptedMessages])
    }
  }

  async syncOutgoing () {
    if (!this.stateloaded)
    {
      throw 'Tried to sync without loading state first'
    }
    const usedOneTimeKeys = []
    const fileList = await this.storageAdapter.getFileList(FILE_PREFIX)
    /* Create initial handshake outgoing messages for all new peers who we don't yet have sessions with */
    for (let actorId in this.peers)
    {
      if (!(actorId in this.sessions))
      {
	this.sessions[actorId] = new Olm.Session()
	const otk = this.peers[actorId].oneTimeKeys[0]
	this.sessions[actorId].create_outbound(this.account, this.peers[actorId].key, otk.key)
	usedOneTimeKeys.push(otk.filename)
	this.outgoingQueues[actorId] = []
	this.outgoingQueues[actorId].push({type: "handshake", body: this.handshakeMessage})
      }
    }
    /* Actually delete one time key files (if any were used) so nobody else tries using them */
    for (let i in usedOneTimeKeys)
    {
      await this.storageAdapter.deleteFile(usedOneTimeKeys[i])
    }

    /* Now upload 3 types of files, our id file, our one-time-key files, and message files (coming from our actorId) */
    const ourKey = JSON.parse(this.account.identity_keys())["curve25519"]
    /* Upload id file */
    if (Object.values(fileList).filter(f => f.name == (FILE_PREFIX + this.actorId.toString() + '.id')).length <= 0 || (await this.storageAdapter.getFile(FILE_PREFIX + this.actorId.toString() + '.id')).contents.toString().trim() != ourKey)
    {
      await this.storageAdapter.putFile(FILE_PREFIX + this.actorId.toString() + '.id', ourKey)
    }

    const otkList = Object.values(fileList).filter(f => f.name.startsWith(FILE_PREFIX + this.actorId.toString() + '.') && f.name.endsWith('.otk'))
    /* Upload one-time key files */
    if (otkList.length < NUM_ONE_TIME_KEYS)
    {
      const listOfOtkIndexes = otkList.filter(f => f.name.split('.').length >= 3).map(f => f.name.split('.')[2])
      let maxIndex = 0
      for (let ind in listOfOtkIndexes)
      {
	if (!isNaN(parseInt(listOfOtkIndexes[ind])))
	{
	  maxIndex = Math.max(maxIndex, parseInt(listOfOtkIndexes[ind]))
	}
      }
      this.account.generate_one_time_keys(NUM_ONE_TIME_KEYS - otkList.length)
      const newOtks = JSON.parse(this.account.one_time_keys()).curve25519;
      const keyIds = Object.keys(newOtks)
      for (let i = maxIndex + 1; i < maxIndex + 1 + (NUM_ONE_TIME_KEYS - otkList.length); i++)
      {
	await this.storageAdapter.putFile(FILE_PREFIX + this.actorId.toString() + '.' + i.toString().padStart(5, '0') + '.otk', newOtks[keyIds[i - (maxIndex + 1)]])
      }
      this.account.mark_keys_as_published()
    }

    let changedPeers = false
    /* First encrypt outgoing messages */
    for (let actorId in this.peers)
    {
      if (!(actorId in this.published))
      {
	this.published[actorId] = new Map()
      }
      let pushThisQueue = false
      if (actorId in this.unpushedQueues)
      {
	pushThisQueue = true
      }

      for (let i in this.outgoingQueues[actorId])
      {
	try
	{
	  this.outgoingQueues[actorId][i].index = this.peers[actorId].currentIndex
	  const ciphertext = this.sessions[actorId].encrypt(JSON.stringify(this.outgoingQueues[actorId][i]))
	  this.published[actorId].set(this.peers[actorId].currentIndex, ciphertext)
	  pushThisQueue = true
	  this.peers[actorId].currentIndex++
	}
	catch (e)
	{
	  this.peers[actorId].encryptionFailures++
	  console.log("Failed encrypt outgoing message with error: "+e.message)
	  changedPeers = true
	}
      }
      const indexes = Array.from(this.published[actorId].keys())
      if (indexes.length > 0 && this.peers[actorId].seenIndex >= indexes[0])
      {
	this.published[actorId] = new Map(Array.from(this.published[actorId].entries()).filter(item => item[0] > this.peers[actorId].seenIndex))
	pushThisQueue = true
      }
      if (pushThisQueue)
      {
	this.outgoingQueues[actorId] = []
	if (!(actorId in this.unpushedQueues))
	{
	  this.unpushedQueues[actorId] = true
	}

	/* Upload message files */
	let uploadText = Array.from(this.published[actorId].entries()).map(item => item[1].type.toString()+item[1].body).join("\n")
	await this.storageAdapter.putFile(FILE_PREFIX + this.actorId.toString() + '.' + actorId.toString() + '.msg', uploadText)

	delete this.unpushedQueues[actorId]
      }
    }

    if (changedPeers)
    {
      this.emit('changedPeers', [this])
    }
  }

  async sync () {
    if (!this.stateloaded)
    {
      throw 'Tried to sync without loading state first'
    }
    await this.saveState()
    await this.syncIncoming()
    await this.processIncoming()
    await this.syncOutgoing()

    this.synced = true
  }

  async getPeers (peerState) {
    const filteredPeers = {}
    for (let peer in this.peers)
    {
      if (this.peers[peer].state == peerState)
      {
	filteredPeers[peer] = this.peers[peer]
      }
    }
    return filteredPeers
  }

  async markPeerTrusted (actorId) {
    if (actorId in this.peers)
    {
      this.peers[actorId].state = "verified"
    }
  }

  async queueOutgoingMessage (actorId, message) {
    this.outgoingQueues[actorId].push({type: "message", body: message})
  }

}

