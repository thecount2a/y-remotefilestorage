import * as fs from 'fs';
import { pid } from 'process'
import { join } from 'path';
import { createHash } from 'crypto';
import { Observable } from 'lib0/observable.js'

function mulberry32(a) {
    return function() {
      var t = a += 0x6D2B79F5;
      t = Math.imul(t ^ t >>> 15, t | 1);
      t ^= t + Math.imul(t ^ t >>> 7, t | 61);
      return ((t ^ t >>> 14) >>> 0) / 4294967296;
    }
}

function getChecksum(path) {
  return new Promise(function (resolve, reject) {
    const hash = createHash('md5');
    const input = fs.createReadStream(path);

    input.on('error', reject);

    input.on('data', function (chunk) {
      hash.update(chunk);
    });

    input.on('close', function () {
      resolve(hash.digest('hex'));
    });
  });
}

export default class NodejsLocalFileStorageAdapter extends Observable {
  constructor (directory, init) {
    super()
    this.directory = directory
    this.rnd = mulberry32(init)

    /* Simply emit online right away since this is not truly an internet-connected storage provider */
    setTimeout(() => {
      this.emit('online', [this])
    }, 10)
  }

  async doesFileCacheHit (pattern) {
    /* Return false since this adapter does not cache */
    return false
  }

  async getFileList (pattern, allowCachedList = false) {
    const files = fs.readdirSync(this.directory, { withFileTypes: true })
    const returnObj = {}
    for (let file in files)
    {
      if (files[file].isFile() && files[file].name.startsWith(pattern))
      {
        returnObj[files[file].name] = {name: files[file].name, uniqueId: await getChecksum(join(this.directory, files[file].name))}
      }
    }
    return returnObj
  }

  async getFile (filename, chance = 0) {
    //if (this.rnd() < 0.1*chance)
    if (this.rnd() < 0.1)
    //if (this.rnd() < 0.0)
    {
      console.log("Getting file "+filename+" ("+pid.toString()+"): FAILED")
      throw "getFile Failure"
    }
    console.log("Getting file "+filename+" ("+pid.toString()+"): SUCCESS")
    const thisPath = join(this.directory, filename)
    const contents = fs.readFileSync(thisPath)
    const obj = {
      contents,
      uniqueId: await getChecksum(thisPath)
    }
    return obj
  }

  async putFile (filename, contents) {
    if (this.rnd() < 0.08)
    //if (this.rnd() < 0.0)
    {
      console.log("Putting file "+filename+" ("+pid.toString()+"): FAILED")
      throw "putFile Failure"
    }
    console.log("Putting file "+filename+" ("+pid.toString()+"): SUCCESS")
    const thisPath = join(this.directory, filename)
    //if (this.rnd() > 0.00)
    if (this.rnd() > 0.04)
    {
      fs.writeFileSync(thisPath, contents)
    }
    else
    {
      console.log("Putting file "+filename+" ("+pid.toString()+"): SILENTLY FAILED AFTER SUCCESS")
    }
    if (this.rnd() < 0.03)
    //if (this.rnd() < 0.0)
    {
      console.log("Putting file "+filename+" ("+pid.toString()+"): FAILED AFTER SUCCESS")
      throw "putFile Failure"
    }
  }

  async deleteFile (filename) {
    //if (this.rnd() < 0.03)
    if (this.rnd() < 0)
    {
      console.log("Deleting file "+filename+" ("+pid.toString()+"): FAILED")
      throw "deleteFile Failure"
    }
    console.log("Deleting file "+filename+" ("+pid.toString()+"): SUCCESS")
    const thisPath = join(this.directory, filename)
    fs.unlinkSync(thisPath)
  }

}

