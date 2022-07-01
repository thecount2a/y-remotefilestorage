import { Observable } from 'lib0/observable.js'
import { SHA256, hash } from "@stablelib/sha256";
import { deriveKey } from "@stablelib/pbkdf2";
import { encode, decode } from "@stablelib/utf8";
import { ByteReader } from "@stablelib/bytereader";
import { ByteWriter } from "@stablelib/bytewriter";
import nacl from 'tweetnacl';
const { secretbox, randomBytes } = nacl;

export default class EncryptionAddonAdapter extends Observable {
  constructor (nextAdapter, encryptionPassword) {
    super()
    this.nextAdapter = nextAdapter
    this.encryptionPassword = encryptionPassword
  }

  async getFileList (pattern, allowCachedList = false) {
    return await this.nextAdapter.getFileList (pattern, allowCachedList) 
  }

  async getFile (filename) {
    const obj = await this.nextAdapter.getFile(filename)
    const r = new ByteReader(obj.contents)
    const nonce = r.read(24)
    const encryptedContents = r.read(r.unreadLength)
    const k = deriveKey(SHA256, encode(this.encryptionPassword), nonce, 10000, 32);
    obj.contents = secretbox.open(encryptedContents, nonce, k)
    return obj
  }

  async putFile (filename, contents) {
    const nonce = randomBytes(24)
    const k = deriveKey(SHA256, encode(this.encryptionPassword), nonce, 10000, 32);
    const encryptedContents = secretbox(contents, nonce, k)
    const w = new ByteWriter(nonce.length + encryptedContents.length);
    w.write(nonce)
    w.write(encryptedContents)
    const encoded = w.finish()
    await this.nextAdapter.putFile(filename, encoded)
  }

  async deleteFile (filename) {
    await this.nextAdapter.deleteFile(filename)
  }

}

