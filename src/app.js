require("dotenv").config();
const fs = require("fs");
const path = require("path");
const { CloudClient, FileTokenStore } = require("cloud189-sdk");

// 单账号并发签到次数:默认 3,限制在 1-10,避免高并发触发风控
const SIGN_CONCURRENCY = Math.min(
  10,
  Math.max(1, parseInt(process.env.SIGN_CONCURRENCY, 10) || 3)
);
const TOKEN_DIR = path.join(__dirname, "..", ".token");

const mask = (u) => (u.length <= 5 ? u : `${u.slice(0, 3)}****${u.slice(-2)}`);

function loadAccounts() {
  const raw = (process.env.TY_ACCOUNTS || "").trim();
  let list;
  if (raw) {
    list = JSON.parse(raw); // 解析失败直接抛出,不静默吞错
    if (!Array.isArray(list)) throw new Error("TY_ACCOUNTS 必须是 JSON 数组");
  } else if (process.env.TY_USERNAME && process.env.TY_PASSWORD) {
    list = [{ userName: process.env.TY_USERNAME, password: process.env.TY_PASSWORD }];
  } else {
    throw new Error("未配置账号:请设置 TY_ACCOUNTS 或 TY_USERNAME/TY_PASSWORD");
  }
  return list.map((a, i) => {
    const userName = a.userName || a.username;
    const { password } = a;
    if (!userName || !password) {
      throw new Error(`账号 #${i + 1} 缺少 userName 或 password`);
    }
    return { userName: String(userName), password: String(password) };
  });
}

async function signAccount({ userName, password }) {
  const client = new CloudClient({
    username: userName,
    password,
    token: new FileTokenStore(path.join(TOKEN_DIR, `${userName}.json`)),
  });

  // 单次登录:显式建立会话,验证码/超时等问题在这里快速暴露
  await client.getSession();

  // 少量并发签到:复用同一会话,不重复登录
  const results = await Promise.allSettled(
    Array.from({ length: SIGN_CONCURRENCY }, () => client.userSign())
  );

  let signed = 0;
  let bonus = 0;
  let alreadySigned = false;
  const errors = [];
  for (const r of results) {
    if (r.status === "fulfilled") {
      if (r.value.isSign) {
        alreadySigned = true;
      } else {
        signed += 1;
        bonus += r.value.netdiskBonus || 0;
      }
    } else {
      errors.push(r.reason);
    }
  }
  return { signed, bonus, alreadySigned, errors };
}

async function main() {
  const accounts = loadAccounts();
  fs.mkdirSync(TOKEN_DIR, { recursive: true });
  console.log(`共 ${accounts.length} 个账号,单账号并发签到 ${SIGN_CONCURRENCY} 次`);

  let failed = 0;
  for (const account of accounts) {
    // 账号之间串行执行,降低风控概率
    const tag = mask(account.userName);
    try {
      const { signed, bonus, alreadySigned, errors } = await signAccount(account);
      if (signed > 0) {
        console.log(`[${tag}] 签到成功 ${signed} 次,共获得 ${bonus}M 空间`);
        if (errors.length > 0) {
          console.warn(`[${tag}] 另有 ${errors.length} 次请求失败(已忽略)`);
        }
      } else if (alreadySigned) {
        console.log(`[${tag}] 今日已签到`);
      } else {
        failed += 1;
        const reason = errors[0] ? errors[0].message || errors[0] : "无有效返回";
        console.error(`[${tag}] 签到失败: ${reason}`);
      }
    } catch (err) {
      failed += 1;
      console.error(`[${tag}] 登录失败: ${err.message || err}`);
    }
  }

  console.log(`完成:成功 ${accounts.length - failed} / ${accounts.length}`);
  if (failed > 0) process.exitCode = 1; // 有账号失败则退出码非 0,CI 如实显示失败
}

main().catch((err) => {
  console.error(err);
  process.exitCode = 1;
});
