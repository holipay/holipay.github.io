/**
 * 存储模块入口
 * 提供工厂函数创建不同的存储后端
 */

const BaseStorage = require("./base.js");
const FileStorage = require("./file-storage.js");
const ApiStorage = require("./api-storage.js");

/**
 * 创建存储实例
 * @param {string} type - 存储类型: 'file' | 'api'
 * @param {object} options - 配置选项
 * @returns {BaseStorage}
 */
function createStorage(type, options = {}) {
  switch (type) {
    case "file":
      return new FileStorage(options.rootDir);
    case "api":
      return new ApiStorage(options.baseUrl, options);
    default:
      throw new Error(`Unknown storage type: ${type}`);
  }
}

module.exports = {
  BaseStorage,
  FileStorage,
  ApiStorage,
  createStorage,
};
