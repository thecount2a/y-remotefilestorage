import { Observable } from 'lib0/observable.js'
import { encode, decode } from "@stablelib/utf8";
import { encode as encodeBase64, decode as decodeBase64 } from "@stablelib/base64";
import { ByteReader } from "@stablelib/bytereader";
import { ByteWriter } from "@stablelib/bytewriter";
import nacl from 'tweetnacl';
const { secretbox, randomBytes } = nacl;

import { Level } from 'level';

export default class DoubleRatchetEncryptionAddonAdapter extends Observable {
  constructor (nextAdapter, doubleRatchetInstance, levelDbName) {
    super()
    this.nextAdapter = nextAdapter
    this.doubleRatchetInstance = doubleRatchetInstance
    this.levelDbName = levelDbName
    /* Local cache too, since level DB takes time to store and we don't want race conditions */
    this._localCache = {}

    this._receivedMessages = this._receivedMessages.bind(this)
    this.doubleRatchetInstance.on("messagesReceived", this._receivedMessages)

    this._levelDb = new Level(levelDbName, { valueEncoding: 'binary' })
  }

  async doesFileCacheHit (pattern) {
    return await this.nextAdapter.doesFileCacheHit(pattern) 
  }

  async getFileList (pattern, allowCachedList = false) {
    return await this.nextAdapter.getFileList (pattern, allowCachedList) 
  }

  async getFile (filename) {
    const obj = await this.nextAdapter.getFile(filename)
    const r = new ByteReader(obj.contents)
    const nonce = r.read(24)
    const encryptedContents = r.read(r.unreadLength)
    let key = null
    try
    {
      key = await this._levelDb.get(filename)
    }
    catch (e)
    {
      if (!e.notFound)
      {
	throw e
      }
      else
      {
	/* Check local cache too, since level DB takes time to store and we don't want race conditions */
	if (filename in this._localCache)
	{
	  key = this._localCache[filename]
	}
      }
    }
    if (!key)
    {
      throw "Failed to find key for filename "+filename
    }
    obj.contents = secretbox.open(encryptedContents, nonce, key)
    return obj
  }

  async putFile (filename, contents, newKey = false) {
    const nonce = randomBytes(24)
    let key = null
    try
    {
      key = await this._levelDb.get(filename)
    }
    catch (e)
    {
      if (!e.notFound)
      {
	throw e
      }
      else
      {
	/* Check local cache too, since level DB takes time to store and we don't want race conditions */
	if (filename in this._localCache)
	{
	  key = this._localCache[filename]
	}
      }
    }
    if (!key || newKey)
    {
      key = randomBytes(32)
      /* Store in local cache too, since level DB takes time to store and we don't want race conditions */
      this._localCache[filename] = key
      await this._levelDb.put(filename, key)

      for (let peer in this.doubleRatchetInstance.peers)
      {
	this.doubleRatchetInstance.queueOutgoingMessage(peer, JSON.stringify({filename, key: encodeBase64(key)}))
      }
    }
    const encryptedContents = secretbox(contents, nonce, key)
    const w = new ByteWriter(nonce.length + encryptedContents.length);
    w.write(nonce)
    w.write(encryptedContents)
    const encoded = w.finish()
    await this.nextAdapter.putFile(filename, encoded)
  }

  async deleteFile (filename) {
    await this.nextAdapter.deleteFile(filename)
    await this._levelDb.del(filename)
    /* Delete from local cache too */
    if (filename in this._localCache)
    {
      delete this._localCache[filename]
    }
  }

  async _receivedMessages(msgs) {
    for (let m in msgs)
    {
      const msg = JSON.parse(msgs[m].body)
      /* Store in local cache too (FIRST), since level DB takes time to store and we don't want race conditions */
      this._localCache[msg.filename] = decodeBase64(msg.key)
      await this._levelDb.put(msg.filename, decodeBase64(msg.key))
    }
  }

  destroy() {
    if (this.doubleRatchetInstance)
    {
      this.doubleRatchetInstance.off("messagesReceived", this._receivedMessages)
    }
  }

}

