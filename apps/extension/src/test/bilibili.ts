/**
 * B 站 newbie quiz, rebuilt from the markup skeleton in a user's debug log (2026-09-24):
 * a class-less card holding the mascot image, div.qa-header (name, progress, stem) and a
 * v-switcher carousel whose active panel has the options.
 */
export const BILIBILI_QUIZ = `
  <div class="bili-header">
    <div class="left-entry">
      <span style="cursor:pointer">首页</span><span style="cursor:pointer">番剧</span>
      <span style="cursor:pointer">直播</span><span style="cursor:pointer">游戏中心</span>
    </div>
    <div class="center-search-container">
      <form id="nav-searchform"><input class="nav-search-input" placeholder="硬币怎么获得"></form>
    </div>
  </div>
  <div class="side"><span>当前得分</span><span>7</span><span>60分</span></div>
  <div>
    <div>
      <img class="qa-tv" src="//s1.hdslb.com/bfs/static/tv.png" width="120" height="120">
      <div class="qa-header">
        <span class="tv-type-text">小电视校长</span>
        <p class="title-number">第 8/100 题</p>
        <div class="title-panel title-panel-v3">B站的美食区视频中，“低卡美食”通常指什么？</div>
      </div>
      <div class="v-switcher">
        <div class="v-switcher-header-wrap"><ul class="v-switcher-header">
          <li class="v-switcher-header-item"></li><li class="v-switcher-header-item is-active"></li>
        </ul></div>
        <div class="v-switcher-content-wrap"><div class="v-switcher-content">
          <div class="v-switcher-content-panel"><div class="question"></div></div>
          <div class="v-switcher-content-panel"><div class="question">
            <div class="answer-outer" style="cursor:pointer"><div class="answer-text">低热量且健康的食品</div></div>
            <div class="answer-outer" style="cursor:pointer"><div class="answer-text">需要快速制作的食品</div></div>
          </div></div>
        </div></div>
      </div>
    </div>
  </div>`;
