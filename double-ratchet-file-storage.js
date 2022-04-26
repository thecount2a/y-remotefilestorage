import { Observable } from 'lib0/observable.js'

import Olm from 'olm'

import { Level } from 'level';

const NUM_ONE_TIME_KEYS = 10
const FILE_PREFIX = 'drchannel.'

export default class DoubleRatchetFileStorage extends Observable {
  constructor (storageAdapter, actorId, handshakeMessage, levelDbName) {
    super()
    this.storageAdapter = storageAdapter
    this.actorId = actorId
    this.account = null
    this.sessions = {}
    this.stateloaded = false
    this.synced = false
    this.peers = {}
    this.handshakeMessage = handshakeMessage

    this._levelDb = new Level(levelDbName, { valueEncoding: 'json' })
  }

  async loadState() {
    if (!this.stateloaded)
    {
      await Olm.init()
    }

    let acct = null
    const data = await this._levelDb.iterator().all()

    this.peers = []

    for (const [key, value] of data)
    {
      if (key == "account")
      {
	acct = value
      }
      else if (key.indexOf("-") >= 0)
      {
	const sp = key.split("-")
	if (!(sp[0] in this.peers))
	{
	  this.peers[sp[0]] = {}
	}
	this.peers[sp[0]][sp[1]] = value
	if (sp[1] == "session")
	{
	  const sessionObj = new Olm.Session()
	  sessionObj.unpickle('fixed_insecure_key', this.peers[sp[0]].session)
	  this.sessions[sp[0]] = sessionObj
	}
      }
    }

    this.account = new Olm.Account();
    if (acct)
    {
      this.account.unpickle('fixed_insecure_key', acct)
    }
    else
    {
      this.account.create()
    }

    this.stateloaded = true
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
	const actorId = parts[1]

	/* Don't overwrite if we've already seen this actor id */
	if (actorId != this.actorId && !(actorId in this.peers))
	{
	  const id_key = await this.storageAdapter.getFile(fileList[f].name)
	  this.peers[actorId] = { key: id_key.contents.toString(), state: "unverified", oneTimeKeys: [], seenIndex: -1, messageFilesSeen: {}, decryptionFailures: 0, encryptionFailures: 0, currentIndex: 0, incomingQueue: [], outgoingQueue: [], unpushedQueue: false, published: [], alreadySeen: {} }

	  /* Flush entire peer object to db */
	  for (let objKey in this.peers[actorId])
	  {
	    await this._levelDb.put(actorId + "-" + objKey, this.peers[actorId][objKey])
	  }
	}
      }
    }

    /* Clear our lists of one time keys so we can rebuild them, but cache the keys themselves so we don't have to re-fetch every key */
    const keyCache = {}
    for (let actorId in this.peers)
    {
      for (let i in this.peers[actorId].oneTimeKeys)
      {
	if (!(actorId in keyCache))
	{
	  keyCache[actorId] = {}
	}
	keyCache[actorId][this.peers[actorId].oneTimeKeys[i].filename] = {filename: this.peers[actorId].oneTimeKeys[i].filename, key: this.peers[actorId].oneTimeKeys[i].key}
      }
      this.peers[actorId].oneTimeKeys = []
    }

    /* Repopulate lists of one time keys */
    for (let f in fileList)
    {
      if (fileList[f].name.endsWith('.otk'))
      {
	const parts = fileList[f].name.split('.')
	const actorId = parts[1]
	if (actorId in this.peers)
	{
	  let otk = null
	  if (actorId in keyCache && fileList[f].name in keyCache[actorId])
	  {
	    otk = keyCache[actorId][fileList[f].name]
	  }
	  else
	  {
	    const keyFile = await this.storageAdapter.getFile(fileList[f].name)
	    otk = {filename: fileList[f].name, key: keyFile.contents.toString()}
	  }
	  this.peers[actorId].oneTimeKeys.push(otk)
	}
      }
    }

    /* Check if anything has changed */
    for (let actorId in this.peers)
    {
      let keyCacheJSON = "{}"
      if (actorId in keyCache)
      {
	keyCacheJSON = JSON.stringify(Array.from(Object.values(keyCache[actorId])))
      }
      if (JSON.stringify(this.peers[actorId].oneTimeKeys) != keyCacheJSON)
      {
	/* Flush one time keys for this peer, since we know they have definitely changed */
	await this._levelDb.put(actorId + "-oneTimeKeys", this.peers[actorId].oneTimeKeys)
      }
    }


    /* Now download any incoming messages */
    const existingFiles = {}
    for (let f in fileList)
    {
      if (fileList[f].name.endsWith('.msg'))
      {
	const currentMessages = []
	const parts = fileList[f].name.split('.')
	const actorId = parts[1]
	if (actorId in this.peers && parts[2] == this.actorId.toString() && this.peers[actorId].messageFilesSeen[fileList[f].name] != fileList[f].uniqueId)
	{
	  /* Only look at message files that are addressed to our actorId, from verified actors */
	  if (this.peers[actorId].state != "unverified")
	  {
	    const msgs = await this.storageAdapter.getFile(fileList[f].name)
	    const msgList = msgs.contents.toString().split(/\r?\n/).filter(e => e && (e[0] == "0" || e[0] == "1"))
	    for (let msg in msgList)
	    {
	      currentMessages.push({type: parseInt(msgList[msg][0]), message: msgList[msg].slice(1), verified: true})
	      if (!(currentMessages[currentMessages.length-1].message in this.peers[actorId].alreadySeen))
	      {
		this.peers[actorId].incomingQueue.push(currentMessages[currentMessages.length-1])
		this.peers[actorId].alreadySeen[currentMessages[currentMessages.length-1].message] = true
	      }
	    }
	  }
	  /* Also, carefully look at message files that are addressed to our actorId, from unverified actors */
	  else
	  {
	    const msgs = await this.storageAdapter.getFile(fileList[f].name)
	    const msgList = msgs.contents.toString().split(/\r?\n/).filter(e => e && e[0] == "0")
	    if (msgList.length > 0)
	    {
	      /* Only let 1 message of size less than 5k for unverified actors to avoid potentially filling up storage with spam */
	      if (msgList[0].length < 5000)
	      {
		currentMessages.push({type: parseInt(msgList[0][0]), message: msgList[0].slice(1), verified: false})
		if (!(currentMessages[currentMessages.length-1].message in this.peers[actorId].alreadySeen))
		{
		  this.peers[actorId].incomingQueue.push(currentMessages[currentMessages.length-1])
		  this.peers[actorId].alreadySeen[currentMessages[currentMessages.length-1].message] = true
		}
	      }
	    }
	  }
	  /* Now we mark that we've seen this version of this message file */
	  this.peers[actorId].messageFilesSeen[fileList[f].name] = fileList[f].uniqueId

	  /* Delete messages from already seen which have disappeared from any files */
	  const messagesOnly = currentMessages.map(ob => ob.message)
	  for (let m in this.peers[actorId].alreadySeen)
	  {
	    /* Make sure we've actually scanned this message file during this run before deleting "rolled-off" history */
	    if (!messagesOnly.includes(m))
	    {
	      delete this.peers[actorId].alreadySeen[m]
	    }
	  }
	  await this._levelDb.put(actorId + "-incomingQueue", this.peers[actorId].incomingQueue)
	  await this._levelDb.put(actorId + "-alreadySeen", this.peers[actorId].alreadySeen)
	  await this._levelDb.put(actorId + "-messageFilesSeen", this.peers[actorId].messageFilesSeen)
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
	  await this._levelDb.put(actorId + "-messageFilesSeen", this.peers[actorId].messageFilesSeen)
	}
      }
    }
  }

  async processIncoming () {
    if (!this.stateloaded)
    {
      throw 'Tried to sync without loading state first'
    }
    const decryptedMessages = []
    let changedPeers = false
    for (let actorId in this.peers)
    {
      const messagesToPop = []
      for (let m in this.peers[actorId].incomingQueue)
      {
	if (!(actorId in this.sessions))
	{
	  this.sessions[actorId] = new Olm.Session()
	  this.sessions[actorId].create_inbound_from(this.account, this.peers[actorId].key, this.peers[actorId].incomingQueue[m].message)
	  this.peers[actorId].outgoingQueue = []
	  this.peers[actorId].outgoingQueue.push({type: "handshake", body: this.handshakeMessage})

	  await this._levelDb.put(actorId + "-outgoingQueue", this.peers[actorId].outgoingQueue)
	  await this._levelDb.put("account", this.account.pickle('fixed_insecure_key'))
	}
	let plaintext = null
	try
	{
	  plaintext = this.sessions[actorId].decrypt(this.peers[actorId].incomingQueue[m].type, this.peers[actorId].incomingQueue[m].message)
	}
	catch (e)
	{
	  this.peers[actorId].decryptionFailures++
	  await this._levelDb.put(actorId + "-decryptionFailures", this.peers[actorId].decryptionFailures)

	  console.log("Failed decrypt incoming message with error: "+e.message)
	  changedPeers = true
	}

	this.peers[actorId].session = this.sessions[actorId].pickle('fixed_insecure_key')
	await this._levelDb.put(actorId + "-session", this.peers[actorId].session)

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
	      await this._levelDb.put(actorId + "-handshake", this.peers[actorId].handshake)
	      changedPeers = true
	    }
	    if (msgObj.type == "seen")
	    {
	      this.peers[actorId].seenIndex = Math.max(msgObj.seenIndex, this.peers[actorId].seenIndex)
	      await this._levelDb.put(actorId + "-seenIndex", this.peers[actorId].seenIndex)
	    }
	    else
	    {
	      this.peers[actorId].outgoingQueue.push({type: "seen", seenIndex: msgObj.index})
	      await this._levelDb.put(actorId + "-outgoingQueue", this.peers[actorId].outgoingQueue)
	    }
	    messagesToPop.push(m)
	  }
	}
      }
      for (let i = messagesToPop.length - 1; i >= 0; i--)
      {
	this.peers[actorId].incomingQueue.splice(messagesToPop[i], 1)
      }
      if (messagesToPop.length > 0)
      {
	await this._levelDb.put(actorId + "-incomingQueue", this.peers[actorId].incomingQueue)
      }
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
	this.peers[actorId].outgoingQueue = []
	this.peers[actorId].outgoingQueue.push({type: "handshake", body: this.handshakeMessage})
	await this._levelDb.put(actorId + "-outgoingQueue", this.peers[actorId].outgoingQueue)

	this.peers[actorId].session = this.sessions[actorId].pickle('fixed_insecure_key')
	await this._levelDb.put(actorId + "-session", this.peers[actorId].session)
	await this._levelDb.put("account", this.account.pickle('fixed_insecure_key'))
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
      await this._levelDb.put("account", this.account.pickle('fixed_insecure_key'))

      const newOtks = JSON.parse(this.account.one_time_keys()).curve25519;
      const keyIds = Object.keys(newOtks)
      for (let i = maxIndex + 1; i < maxIndex + 1 + (NUM_ONE_TIME_KEYS - otkList.length); i++)
      {
	await this.storageAdapter.putFile(FILE_PREFIX + this.actorId.toString() + '.' + i.toString().padStart(5, '0') + '.otk', newOtks[keyIds[i - (maxIndex + 1)]])
      }
      this.account.mark_keys_as_published()
      await this._levelDb.put("account", this.account.pickle('fixed_insecure_key'))
    }

    let changedPeers = false
    /* First encrypt outgoing messages */
    for (let actorId in this.peers)
    {
      let pushThisQueue = false
      if (this.peers[actorId].unpushedQueue)
      {
	pushThisQueue = true
      }

      for (let i in this.peers[actorId].outgoingQueue)
      {
	try
	{
	  this.peers[actorId].outgoingQueue[i].index = this.peers[actorId].currentIndex
	  const ciphertext = this.sessions[actorId].encrypt(JSON.stringify(this.peers[actorId].outgoingQueue[i]))

	  this.peers[actorId].session = this.sessions[actorId].pickle('fixed_insecure_key')
	  await this._levelDb.put(actorId + "-session", this.peers[actorId].session)

	  this.peers[actorId].published.push([this.peers[actorId].currentIndex, ciphertext])
	  pushThisQueue = true
	  this.peers[actorId].currentIndex++
	  await this._levelDb.put(actorId + "-currentIndex", this.peers[actorId].currentIndex)
	}
	catch (e)
	{
	  this.peers[actorId].encryptionFailures++
	  await this._levelDb.put(actorId + "-encryptionFailures", this.peers[actorId].encryptionFailures)
	  console.log("Failed encrypt outgoing message with error: "+e.message)
	  changedPeers = true
	}
      }
      if (this.peers[actorId].published.length > 0 && this.peers[actorId].seenIndex >= this.peers[actorId].published[0][0])
      {
	this.peers[actorId].published = this.peers[actorId].published.filter(item => item[0] > this.peers[actorId].seenIndex)
	pushThisQueue = true
      }
      if (pushThisQueue)
      {
	await this._levelDb.put(actorId + "-published", this.peers[actorId].published)

	this.peers[actorId].outgoingQueue = []
	await this._levelDb.put(actorId + "-outgoingQueue", this.peers[actorId].outgoingQueue)
	if (!this.peers[actorId].unpushedQueue)
	{
	  this.peers[actorId].unpushedQueue = true
	  await this._levelDb.put(actorId + "-unpushedQueue", this.peers[actorId].unpushedQueue)
	}

	/* Upload message files */
	let uploadText = this.peers[actorId].published.map(item => item[1].type.toString()+item[1].body).join("\n")
	await this.storageAdapter.putFile(FILE_PREFIX + this.actorId.toString() + '.' + actorId.toString() + '.msg', uploadText)

	this.peers[actorId].unpushedQueue = false
	await this._levelDb.put(actorId + "-unpushedQueue", this.peers[actorId].unpushedQueue)
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
    await this.syncIncoming()
    await this.processIncoming()
    await this.syncOutgoing()

    this.synced = true
  }

  getPeers (peerState) {
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
    await this._levelDb.put(actorId + "-state", this.peers[actorId].state)
  }

  async queueOutgoingMessage (actorId, message) {
    if (actorId in this.peers)
    {
      this.peers[actorId].outgoingQueue.push({type: "message", body: message})
      await this._levelDb.put(actorId + "-outgoingQueue", this.peers[actorId].outgoingQueue)
    }
  }

}

