/**
 * 存储接口基类
 * 定义所有存储后端必须实现的方法
 */

class BaseStorage {
  /**
   * 读取 JSON 数据
   * @param {string} key - 数据键（文件路径或API路径）
   * @param {*} defaultValue - 默认值
   * @returns {Promise<*>}
   */
  async readJson(key, defaultValue = null) {
    throw new Error('readJson() must be implemented');
  }

  /**
   * 写入 JSON 数据
   * @param {string} key - 数据键
   * @param {*} data - 要写入的数据
   * @param {object} options - 选项
   * @returns {Promise<void>}
   */
  async writeJson(key, data, options = {}) {
    throw new Error('writeJson() must be implemented');
  }

  /**
   * 检查数据是否存在
   * @param {string} key - 数据键
   * @returns {Promise<boolean>}
   */
  async exists(key) {
    throw new Error('exists() must be implemented');
  }

  /**
   * 列出指定前缀下的所有键
   * @param {string} prefix - 键前缀
   * @returns {Promise<string[]>}
   */
  async listKeys(prefix) {
    throw new Error('listKeys() must be implemented');
  }

  /**
   * 删除数据
   * @param {string} key - 数据键
   * @returns {Promise<void>}
   */
  async delete(key) {
    throw new Error('delete() must be implemented');
  }
}

module.exports = BaseStorage;
