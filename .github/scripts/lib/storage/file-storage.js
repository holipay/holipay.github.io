/**
 * 本地文件存储实现
 * 将数据存储为本地 JSON 文件
 */

const fs = require("fs");
const fsPromises = fs.promises;
const path = require("path");
const BaseStorage = require("./base.js");

class FileStorage extends BaseStorage {
  /**
   * @param {string} rootDir - 根目录
   */
  constructor(rootDir) {
    super();
    this.rootDir = rootDir;
  }

  /**
   * 解析完整的文件路径
   * @param {string} key - 相对路径键
   * @returns {string}
   */
  _resolvePath(key) {
    // 安全检查：防止路径遍历攻击
    const resolved = path.resolve(this.rootDir, key);
    if (!resolved.startsWith(this.rootDir)) {
      throw new Error(`Invalid path: ${key}`);
    }
    return resolved;
  }

  async readJson(key, defaultValue = null) {
    try {
      const filePath = this._resolvePath(key);
      if (!fs.existsSync(filePath)) return defaultValue;
      const content = await fsPromises.readFile(filePath, "utf-8");
      return JSON.parse(content);
    } catch {
      return defaultValue;
    }
  }

  async writeJson(key, data, options = {}) {
    const filePath = this._resolvePath(key);
    const dir = path.dirname(filePath);
    
    // 确保目录存在
    if (!fs.existsSync(dir)) {
      await fsPromises.mkdir(dir, { recursive: true });
    }

    const json = options.compact 
      ? JSON.stringify(data) 
      : JSON.stringify(data, null, 2);

    // 原子写入
    const tmpPath = filePath + ".tmp";
    await fsPromises.writeFile(tmpPath, json, "utf-8");
    await fsPromises.rename(tmpPath, filePath);
  }

  async exists(key) {
    const filePath = this._resolvePath(key);
    return fs.existsSync(filePath);
  }

  async listKeys(prefix) {
    const dirPath = this._resolvePath(prefix);
    if (!fs.existsSync(dirPath)) return [];
    
    try {
      const files = await fsPromises.readdir(dirPath);
      return files
        .filter(f => f.endsWith(".json"))
        .map(f => path.join(prefix, f));
    } catch {
      return [];
    }
  }

  async delete(key) {
    const filePath = this._resolvePath(key);
    if (fs.existsSync(filePath)) {
      await fsPromises.unlink(filePath);
    }
  }
}

module.exports = FileStorage;
