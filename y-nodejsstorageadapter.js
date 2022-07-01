import * as fs from 'fs';
import { join } from 'path';
import { createHash } from 'crypto';
import { Observable } from 'lib0/observable.js'

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
  constructor (directory) {
    super()
    this.directory = directory

    /* Simply emit online right away since this is not truly an internet-connected storage provider */
    setTimeout(() => {
      this.emit('online', [this])
    }, 10)
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

  async getFile (filename) {
    const thisPath = join(this.directory, filename)
    const contents = fs.readFileSync(thisPath)
    const obj = {
      contents,
      uniqueId: await getChecksum(thisPath)
    }
    return obj
  }

  async putFile (filename, contents) {
    const thisPath = join(this.directory, filename)
    fs.writeFileSync(thisPath, contents)
  }

  async deleteFile (filename) {
    const thisPath = join(this.directory, filename)
    fs.unlinkSync(thisPath)
  }

}

