import { Observable } from 'lib0/observable.js'
import { encode, decode } from "@stablelib/utf8";
import { encode as encodeBase64, decode as decodeBase64 } from "@stablelib/base64";
import { ByteReader } from "@stablelib/bytereader";
import { ByteWriter } from "@stablelib/bytewriter";
import nacl from 'tweetnacl';
const { secretbox, randomBytes } = nacl;

export default class DoubleRatchetEncryptionAddonAdapter extends Observable {
  constructor (nextAdapter, doubleRatchetInstance, levelUpDb) {
    super()
    this.nextAdapter = nextAdapter
    this.doubleRatchetInstance = doubleRatchetInstance
    this._levelUpDb = levelUpDb

    this._receivedMessages = this._receivedMessages.bind(this)
    this.doubleRatchetInstance.on("messagesReceived", this._receivedMessages)
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
      key = await this._levelUpDb.get(filename)
    }
    catch (e)
    {
      if (!e.notFound)
      {
	throw e
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
      key = await this._levelUpDb.get(filename)
    }
    catch (e)
    {
      if (!e.notFound)
      {
	throw e
      }
    }
    if (!key || newKey)
    {
      key = randomBytes(32)
      await this._levelUpDb.put(filename, key)

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
    await this._levelUpDb.del(filename)
  }

  async _receivedMessages(msgs) {
    for (let m in msgs)
    {
      const msg = JSON.parse(msgs[m].body)
      await this._levelUpDb.put(msg.filename, decodeBase64(msg.key))
    }
  }

  destroy() {
    if (this.doubleRatchetInstance)
    {
      this.doubleRatchetInstance.off("messagesReceived", this._receivedMessages)
    }
  }

}

