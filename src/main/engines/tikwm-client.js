/**
 * tikwm-client.js — TikWM API 客户端
 *
 * 轻量 HTTP 客户端，移植自 BB-Tiktok background.js 的 TikWM 调用逻辑。
 * 免费→付费 fallback、速率控制、评论 region 采样。
 *
 * 用法：
 *   const TikWMClient = require('./tikwm-client');
 *   const client = new TikWMClient({ apiKey: '...' });
 *   const videos = await client.getUserVideos('username');
 *   const regions = await client.sampleAudienceRegions('username', videos, 200);
 */

'use strict';

// ═══════════════════════════════════════════════════════
// 默认配置
// ═══════════════════════════════════════════════════════

const DEFAULTS = {
  freeBaseUrl: 'https://www.tikwm.com/api',
  paidBaseUrl: 'https://api.tikwmapi.com',
  apiKey: '',
  /** 免费→付费路径映射 */
  pathMap: {
    '/feed/search': '/search/feed',
  },
  /** 请求间隔 ms */
  requestDelay: 200,
  /** 单视频评论采样上限 */
  maxPerVideo: 80,
  /** 每视频评论最多拉几页（每页50条） */
  maxCommentPages: 3,
};

// ═══════════════════════════════════════════════════════
// 工具
// ═══════════════════════════════════════════════════════

function sleep(ms) {
  return new Promise(resolve => setTimeout(resolve, ms));
}

function buildQueryString(params) {
  return Object.entries(params)
    .filter(([, v]) => v !== undefined && v !== null)
    .map(([k, v]) => `${encodeURIComponent(k)}=${encodeURIComponent(v)}`)
    .join('&');
}

// ═══════════════════════════════════════════════════════
// TikWMClient
// ═══════════════════════════════════════════════════════

class TikWMClient {
  /**
   * @param {Object} opts
   * @param {string} opts.apiKey — TikWM 付费 API key
   * @param {string} [opts.freeBaseUrl]
   * @param {string} [opts.paidBaseUrl]
   * @param {number} [opts.requestDelay=200]
   * @param {Function} [opts.log] — 日志函数，默认 console.log
   */
  constructor(opts = {}) {
    this.cfg = { ...DEFAULTS, ...opts };
    this.log = opts.log || console.log;
    this._lastRequestTime = 0;
  }

  // ───────────────────────────────────────────────────
  // 速率控制
  // ───────────────────────────────────────────────────

  async _throttle() {
    const now = Date.now();
    const elapsed = now - this._lastRequestTime;
    if (elapsed < this.cfg.requestDelay) {
      await sleep(this.cfg.requestDelay - elapsed);
    }
    this._lastRequestTime = Date.now();
  }

  // ───────────────────────────────────────────────────
  // 统一请求：免费→付费 fallback
  // ───────────────────────────────────────────────────

  /**
   * @param {string} path — API 路径，如 '/user/posts'
   * @param {Object} params — 查询/body 参数
   * @param {Object} [options]
   * @param {string} [options.freeMethod='GET'] — 免费接口请求方式
   * @returns {Promise<Object>} — API 响应 data
   */
  async _fetch(path, params, { freeMethod = 'GET' } = {}) {
    await this._throttle();

    const qs = buildQueryString(params);

    // 1. 尝试免费接口
    try {
      let resp;
      if (freeMethod === 'POST') {
        resp = await fetch(`${this.cfg.freeBaseUrl}${path}`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
          body: qs,
        });
      } else {
        resp = await fetch(`${this.cfg.freeBaseUrl}${path}${qs ? '?' + qs : ''}`);
      }

      if (resp.ok) {
        const result = await resp.json();
        if (result.code === 0 && result.data) {
          return result.data;
        }
      }
    } catch (_) {
      // 免费接口失败，静默降级
    }

    // 2. 付费接口 fallback
    if (!this.cfg.apiKey) {
      throw new Error(`TikWM 免费接口失败且无 API key，无法降级付费接口 (${path})`);
    }

    await this._throttle();

    const paidPath = this.cfg.pathMap[path] || path;
    const paidUrl = `${this.cfg.paidBaseUrl}${paidPath}${qs ? '?' + qs : ''}`;

    const resp = await fetch(paidUrl, {
      headers: { 'x-tikwmapi-key': this.cfg.apiKey },
    });

    if (!resp.ok) {
      throw new Error(`TikWM 付费接口 HTTP ${resp.status} (${paidPath})`);
    }

    const result = await resp.json();
    if (result.code !== 0) {
      throw new Error(`TikWM 付费接口错误: ${result.msg || JSON.stringify(result)} (${paidPath})`);
    }

    return result.data;
  }

  // ───────────────────────────────────────────────────
  // 获取用户视频列表
  // ───────────────────────────────────────────────────

  /**
   * 三级降级获取用户视频：
   *   1. /user/posts (POST) — 最完整
   *   2. /feed/search (GET) — 搜索匹配
   *   3. 逐个 / (GET) — 单视频详情补全
   *
   * @param {string} username — TikTok 用户名（不含@）
   * @param {number} [count=50] — 请求数量
   * @param {string[]} [knownVideoIds=[]] — 已知视频ID列表（用于方案3补全）
   * @returns {Promise<Array>} — 标准化视频数组 [{ id, playCount, diggCount, commentCount, shareCount, createTime }]
   */
  async getUserVideos(username, count = 50, knownVideoIds = []) {
    // 方案1: /user/posts
    try {
      const data = await this._fetch('/user/posts', { unique_id: username, count }, { freeMethod: 'POST' });
      if (data.videos && data.videos.length > 0) {
        this.log(`[TikWM] /user/posts 成功: ${username}, ${data.videos.length} 视频`);
        return this._normalizeVideos(data.videos);
      }
    } catch (_) {
      // 降级
    }

    // 方案2: /feed/search
    try {
      const data = await this._fetch('/feed/search', { keywords: username, count: 30 });
      const videos = (data.videos || []).filter(v =>
        v.author && v.author.unique_id && v.author.unique_id.toLowerCase() === username.toLowerCase()
      );
      if (videos.length > 0) {
        this.log(`[TikWM] /feed/search 成功: ${username}, ${videos.length} 视频`);
        return this._normalizeVideos(videos);
      }
    } catch (_) {
      // 降级
    }

    // 方案3: 逐个视频详情（需要已知 videoId）
    if (knownVideoIds.length > 0) {
      const ids = knownVideoIds.slice(0, 10);
      this.log(`[TikWM] 逐个获取视频详情: ${username}, ${ids.length} 个`);

      const results = await Promise.allSettled(
        ids.map(async (vid) => {
          await this._throttle();
          const data = await this._fetch('/', { url: `https://www.tiktok.com/@${username}/video/${vid}` });
          return data;
        })
      );

      const videos = results
        .filter(r => r.status === 'fulfilled' && r.value)
        .map(r => r.value);

      if (videos.length > 0) {
        return this._normalizeVideos(videos);
      }
    }

    this.log(`[TikWM] 所有方案失败: ${username}`);
    return [];
  }

  /**
   * 标准化视频数据格式
   */
  _normalizeVideos(rawVideos) {
    return rawVideos.map(v => ({
      id: String(v.video_id || v.id || ''),
      playCount: v.play_count ?? v.playCount ?? 0,
      diggCount: v.digg_count ?? v.diggCount ?? 0,
      commentCount: v.comment_count ?? v.commentCount ?? 0,
      shareCount: v.share_count ?? v.shareCount ?? 0,
      createTime: v.create_time ?? v.createTime ?? 0,
    }));
  }

  // ───────────────────────────────────────────────────
  // 获取视频评论（提取受众 region）
  // ───────────────────────────────────────────────────

  /**
   * 获取单个视频的评论，提取 user.region
   *
   * @param {string} username
   * @param {string} videoId
   * @param {number} [maxSamples=80] — 单视频采样上限
   * @returns {Promise<{ regions: { [cc: string]: number }, total: number }>}
   */
  async getVideoCommentRegions(username, videoId, maxSamples) {
    maxSamples = maxSamples || this.cfg.maxPerVideo;
    const regions = {};
    const seenUids = new Set();
    let total = 0;

    for (let page = 0; page < this.cfg.maxCommentPages; page++) {
      if (total >= maxSamples) break;

      try {
        const data = await this._fetch('/comment/list', {
          url: `https://www.tiktok.com/@${username}/video/${videoId}`,
          count: 50,
          cursor: page * 50,
        });

        const comments = data.comments || [];
        if (comments.length === 0) break;

        for (const c of comments) {
          if (total >= maxSamples) break;

          const uid = c.user?.uid || c.user?.id;
          const region = c.user?.region;

          if (!uid || !region || seenUids.has(uid)) continue;

          seenUids.add(uid);
          regions[region] = (regions[region] || 0) + 1;
          total++;
        }

        // 不足一页说明没有更多评论了
        if (comments.length < 50) break;
      } catch (err) {
        this.log(`[TikWM] 评论获取失败: video=${videoId}, page=${page}, ${err.message}`);
        break;
      }
    }

    return { regions, total };
  }

  // ───────────────────────────────────────────────────
  // 批量受众 region 采样
  // ───────────────────────────────────────────────────

  /**
   * 采样受众 region 分布
   *
   * 策略：优先挑评论最多的视频，并发拉取评论 region，
   * 达到目标样本量后停止。
   *
   * @param {string} username
   * @param {Array} videos — getUserVideos 返回的标准化视频数组
   * @param {number} [targetSamples=200]
   * @returns {Promise<{ regionDistribution: { [cc: string]: number }, totalSamples: number }>}
   */
  async sampleAudienceRegions(username, videos, targetSamples = 200) {
    if (!videos || videos.length === 0) {
      return { regionDistribution: {}, totalSamples: 0 };
    }

    // 按评论数降序，优先拉评论多的视频
    const sorted = [...videos]
      .filter(v => v.id && v.commentCount > 0)
      .sort((a, b) => b.commentCount - a.commentCount);

    const regionDistribution = {};
    let totalSamples = 0;

    // 第一批：取评论最多的前 5 个视频
    const batch1 = sorted.slice(0, 5);
    const batch1Results = await Promise.allSettled(
      batch1.map(v => this.getVideoCommentRegions(username, v.id))
    );

    for (const r of batch1Results) {
      if (r.status !== 'fulfilled') continue;
      for (const [cc, count] of Object.entries(r.value.regions)) {
        regionDistribution[cc] = (regionDistribution[cc] || 0) + count;
      }
      totalSamples += r.value.total;
    }

    // 不够目标量 → 继续拉剩余视频（逐个，带速率控制）
    if (totalSamples < targetSamples && sorted.length > 5) {
      const remaining = sorted.slice(5);
      for (const v of remaining) {
        if (totalSamples >= targetSamples) break;

        const perVideoMax = Math.min(this.cfg.maxPerVideo, targetSamples - totalSamples);
        try {
          const result = await this.getVideoCommentRegions(username, v.id, perVideoMax);
          for (const [cc, count] of Object.entries(result.regions)) {
            regionDistribution[cc] = (regionDistribution[cc] || 0) + count;
          }
          totalSamples += result.total;
        } catch (_) {
          // 跳过失败的视频
        }
      }
    }

    this.log(`[TikWM] region 采样完成: ${username}, ${totalSamples}/${targetSamples} 样本, ${Object.keys(regionDistribution).length} 个国家`);

    return { regionDistribution, totalSamples };
  }
}

module.exports = TikWMClient;
