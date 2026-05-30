/**
 * API 存储实现（预留）
 * 通过 HTTP API 读写数据
 * 
 * TODO: 实现具体的 API 调用逻辑
 */

const BaseStorage = require("./base.js");

class ApiStorage extends BaseStorage {
  /**
   * @param {string} baseUrl - API 基础 URL
   * @param {object} options - 配置选项
   * @param {string} options.apiKey - API 密钥
   * @param {number} options.timeout - 超时时间
   */
  constructor(baseUrl, options = {}) {
    super();
    this.baseUrl = baseUrl.replace(/\/$/, "");
    this.apiKey = options.apiKey;
    this.timeout = options.timeout || 30000;
  }

  async readJson(key, defaultValue = null) {
    // TODO: 实现 API 读取
    // const response = await fetch(`${this.baseUrl}/${key}`, {
    //   headers: { 'Authorization': `Bearer ${this.apiKey}` }
    // });
    // if (!response.ok) return defaultValue;
    // return response.json();
    console.warn("ApiStorage.readJson() not implemented yet");
    return defaultValue;
  }

  async writeJson(key, data, options = {}) {
    // TODO: 实现 API 写入
    // await fetch(`${this.baseUrl}/${key}`, {
    //   method: 'PUT',
    //   headers: {
    //     'Authorization': `Bearer ${this.apiKey}`,
    //     'Content-Type': 'application/json'
    //   },
    //   body: JSON.stringify(data)
    // });
    console.warn("ApiStorage.writeJson() not implemented yet");
  }

  async exists(key) {
    // TODO: 实现 API 检查
    console.warn("ApiStorage.exists() not implemented yet");
    return false;
  }

  async listKeys(prefix) {
    // TODO: 实现 API 列表
    console.warn("ApiStorage.listKeys() not implemented yet");
    return [];
  }

  async delete(key) {
    // TODO: 实现 API 删除
    console.warn("ApiStorage.delete() not implemented yet");
  }
}

module.exports = ApiStorage;
