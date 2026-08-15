// ============================================================================
// Yaraav Bot 高级管理系统（中文版 / 修正 API / 支持中文长文翻译）
// ----------------------------------------------------------------------------
// Copyright (c) 2026 培哥. 版权所有。
// 频道: https://t.me/pgkj666   |   联系机器人: https://t.me/pgkj666_bot
// 基于 MIT 许可证开源，保留版权声明。
// ============================================================================

const CONFIG = {
  TELEGRAM_TOKEN: "YOUR_TELEGRAM_BOT_TOKEN", // ⚠️ 请填入你的 Telegram 机器人 Token
  OWNER_ID: 0,                               // ⚠️ 请填入所有者(管理员)的数字 ID

  // 密码加盐用的固定盐值，建议改成你自己的随机字符串（越长越好）
  PASSWORD_SALT: "CHANGE_ME_RANDOM_SALT_pgkj666"
};

// ============================================================================
// 密码安全：SHA-256 + 盐 哈希（Cloudflare Workers 原生支持 Web Crypto）
// ----------------------------------------------------------------------------
// 说明：密码不再明文存储，只存哈希值。所有者面板也无法再看到原始密码。
// 为兼容历史明文数据，登录时若发现旧的明文密码会自动升级为哈希。
// ============================================================================

async function hashPassword(password) {
  const data = new TextEncoder().encode(`${CONFIG.PASSWORD_SALT}::${password}`);
  const digest = await crypto.subtle.digest("SHA-256", data);
  return "sha256$" + [...new Uint8Array(digest)]
    .map((b) => b.toString(16).padStart(2, "0"))
    .join("");
}

// 校验密码：优先按哈希比对；若存储的是旧明文则直接比对（用于平滑迁移）
async function verifyPassword(inputPassword, storedValue) {
  if (typeof storedValue !== "string") return false;
  if (storedValue.startsWith("sha256$")) {
    const inputHash = await hashPassword(inputPassword);
    return timingSafeEqual(inputHash, storedValue);
  }
  // 旧的明文密码
  return timingSafeEqual(inputPassword, storedValue);
}

// 判断存储值是否为旧明文（用于登录成功后自动升级）
function isLegacyPlain(storedValue) {
  return typeof storedValue === "string" && !storedValue.startsWith("sha256$");
}

// 定长时间比较，降低时序攻击风险
function timingSafeEqual(a, b) {
  if (a.length !== b.length) return false;
  let result = 0;
  for (let i = 0; i < a.length; i++) {
    result |= a.charCodeAt(i) ^ b.charCodeAt(i);
  }
  return result === 0;
}

addEventListener("fetch", (event) => {
  event.respondWith(handleRequest(event.request));
});

async function handleRequest(request) {
  if (request.method !== "POST") {
    return new Response("Yaraav Bot is running!", { status: 200 });
  }

  try {
    const update = await request.json();

    // 1. 处理机器人被加入/移出频道
    if (update.my_chat_member) {
      await handleBotChatMemberUpdate(update.my_chat_member);
    }

    // 2. 处理私聊消息
    if (update.message && update.message.chat.type === "private") {
      await handlePrivateMessage(update.message);
    }

    // 3. 处理内联按钮点击
    if (update.callback_query) {
      await handleCallbackQuery(update.callback_query);
    }
  } catch (err) {
    console.error("Critical Webhook Error:", err);
  }

  return new Response("OK", { status: 200 });
}

// ============================================================================
// 1. 强制加入频道检查 (Force Join)
// ============================================================================

async function checkForceJoin(userId) {
  if (userId === CONFIG.OWNER_ID) return true;

  const fch = await getKV("force_channel");
  if (!fch || !fch.username) return true;

  try {
    const res = await sendTelegram("getChatMember", {
      chat_id: fch.username,
      user_id: userId
    });

    if (res.ok && ["creator", "administrator", "member"].includes(res.result.status)) {
      return true;
    }
  } catch (e) {
    console.error("Force Join Check Error:", e);
  }

  return false;
}

// ============================================================================
// 2. 处理机器人在频道中的成员状态变化
// ============================================================================

async function handleBotChatMemberUpdate(update) {
  const chat = update.chat;
  const fromUser = update.from;
  const newStatus = update.new_chat_member.status;

  if (chat.type !== "channel") return;

  const userId = fromUser.id;
  const channelId = chat.id;
  const channelTitle = chat.title || "频道";

  if (newStatus === "administrator") {
    let userChannels = (await getKV(`channels_${userId}`)) || [];
    if (!userChannels.some((c) => c.id === channelId)) {
      userChannels.push({ id: channelId, title: channelTitle, api: null });
      await setKV(`channels_${userId}`, userChannels);
    }
    // 记录「频道 -> 所有者」映射，供翻译时定位所有者的 API 密钥
    await setKV(`channel_owner_${channelId}`, userId);

    await sendTelegram("sendMessage", {
      chat_id: userId,
      text: `🎉 **机器人已成功添加到频道 “${channelTitle}”！**\n\n如需给某条帖子启用翻译按钮，只需把该帖子转发到机器人的私聊即可。`,
      parse_mode: "Markdown"
    });
  }

  if (newStatus === "kicked" || newStatus === "left" || newStatus === "member") {
    let userChannels = (await getKV(`channels_${userId}`)) || [];
    userChannels = userChannels.filter((c) => c.id !== channelId);
    await setKV(`channels_${userId}`, userChannels);
    await deleteKV(`channel_owner_${channelId}`);

    await sendTelegram("sendMessage", {
      chat_id: userId,
      text: `⚠️ **机器人已从频道 “${channelTitle}” 中移除。**\n该频道已从你的活跃频道列表中删除。`,
      parse_mode: "Markdown"
    });
  }
}

// ============================================================================
// 3. 处理私聊消息 & 转发帖子后启用翻译
// ============================================================================

async function handlePrivateMessage(msg) {
  const chatId = msg.chat.id;
  const userId = msg.from.id;
  const text = msg.text || "";

  // 启动机器人
  if (text === "/start") {
    await setKV(`state_${userId}`, null);

    if (userId === CONFIG.OWNER_ID) {
      return showAdminPanel(chatId);
    } else {
      const userLang = await getKV(`lang_${userId}`);
      if (!userLang) {
        return showLanguageSelection(chatId);
      }

      const isJoined = await checkForceJoin(userId);
      if (!isJoined) return sendForceJoinMessage(chatId);

      return showUserAuthMenu(chatId);
    }
  }

  // 其他消息也要检查强制加入
  if (userId !== CONFIG.OWNER_ID) {
    const isJoined = await checkForceJoin(userId);
    if (!isJoined) return sendForceJoinMessage(chatId);
  }

  // 检查用户是否转发了自己频道的帖子，以便在其下方加翻译按钮
  if (msg.forward_from_chat && msg.forward_from_chat.type === "channel") {
    const channelId = msg.forward_from_chat.id;
    const forwardMsgId = msg.forward_from_message_id;

    const userChannels = (await getKV(`channels_${userId}`)) || [];
    const isOwnerOfChannel = userChannels.some((c) => c.id === channelId) || userId === CONFIG.OWNER_ID;

    if (!isOwnerOfChannel) {
      return sendTelegram("sendMessage", {
        chat_id: chatId,
        text: "❌ 该频道未登记在你所管理的频道列表中。"
      });
    }

    // 给频道中指定帖子添加翻译按钮
    const keyboard = {
      inline_keyboard: [
        [
          { text: "🇨🇳 中文", callback_data: `tr_zh_${channelId}_${forwardMsgId}` },
          { text: "🇮🇷 فارسی", callback_data: `tr_fa_${channelId}_${forwardMsgId}` }
        ],
        [
          { text: "🇬🇧 English", callback_data: `tr_en_${channelId}_${forwardMsgId}` },
          { text: "🇷🇺 Русский", callback_data: `tr_ru_${channelId}_${forwardMsgId}` }
        ]
      ]
    };

    const res = await sendTelegram("editMessageReplyMarkup", {
      chat_id: channelId,
      message_id: forwardMsgId,
      reply_markup: keyboard
    });

    if (res.ok) {
      return sendTelegram("sendMessage", {
        chat_id: chatId,
        text: `✅ **已成功为所选帖子启用翻译功能！**`
      });
    } else {
      return sendTelegram("sendMessage", {
        chat_id: chatId,
        text: `❌ 向频道添加按钮失败。请确认机器人在该频道有“编辑消息”的权限。`
      });
    }
  }

  // 用户与管理员的多步状态
  const userState = await getKV(`state_${userId}`);

  if (userId === CONFIG.OWNER_ID && userState) {
    if (userState.step === "SET_FORCE_CHANNEL") {
      let chInput = text.trim();
      if (!chInput.startsWith("@") && !chInput.startsWith("-100")) {
        chInput = "@" + chInput;
      }
      await setKV("force_channel", { username: chInput });
      await setKV(`state_${userId}`, null);

      return sendTelegram("sendMessage", {
        chat_id: chatId,
        text: `✅ **强制加入频道已成功设置：**\n${chInput}`,
        reply_markup: {
          inline_keyboard: [[{ text: "🔙 返回面板", callback_data: "admin_main" }]]
        }
      });
    }

    if (userState.step === "ADD_USER_USERNAME") {
      await setKV(`state_${userId}`, { step: "ADD_USER_PASSWORD", targetUsername: text });
      return sendTelegram("sendMessage", {
        chat_id: chatId,
        text: `🔑 用户名 **${text}** 已记录。\n现在请输入要设置的密码：`
      });
    }

    if (userState.step === "ADD_USER_PASSWORD") {
      const username = userState.targetUsername;
      const password = text;

      const passwordHash = await hashPassword(password);
      const userObj = { username, password: passwordHash, approved: true };
      await setKV(`user_uname_${username}`, userObj);

      let allUsers = (await getKV("all_users_list")) || [];
      if (!allUsers.includes(username)) allUsers.push(username);
      await setKV("all_users_list", allUsers);

      await setKV(`state_${userId}`, null);

      return sendTelegram("sendMessage", {
        chat_id: chatId,
        text: `✅ 用户 **${username}** 已成功创建！`,
        reply_markup: {
          inline_keyboard: [[{ text: "🔙 返回菜单", callback_data: "admin_users_menu" }]]
        }
      });
    }

    if (userState.step === "RESET_USER_PASSWORD") {
      const targetUser = userState.targetUsername;
      const userData = await getKV(`user_uname_${targetUser}`);
      if (!userData) {
        await setKV(`state_${userId}`, null);
        return sendTelegram("sendMessage", {
          chat_id: chatId,
          text: `❌ 未找到用户 ${targetUser}。`
        });
      }
      userData.password = await hashPassword(text);
      await setKV(`user_uname_${targetUser}`, userData);
      await setKV(`state_${userId}`, null);
      return sendTelegram("sendMessage", {
        chat_id: chatId,
        text: `✅ 用户 **${targetUser}** 的密码已重置（已加密存储）。`,
        parse_mode: "Markdown",
        reply_markup: {
          inline_keyboard: [[{ text: "🔙 返回菜单", callback_data: "admin_users_menu" }]]
        }
      });
    }
  }

  if (userState) {
    if (userState.step === "REQ_USERNAME") {
      await setKV(`state_${userId}`, { step: "REQ_PASSWORD", reqUsername: text });
      return sendTelegram("sendMessage", {
        chat_id: chatId,
        text: "🔐 请为你的账户设置一个密码："
      });
    }

    if (userState.step === "REQ_PASSWORD") {
      const username = userState.reqUsername;
      const password = text;

      let requests = (await getKV("pending_requests")) || [];
      // 注册申请里就存哈希，避免明文密码在待审列表中停留
      requests.push({ userId, username, password: await hashPassword(password) });
      await setKV("pending_requests", requests);

      await setKV(`state_${userId}`, null);

      return sendTelegram("sendMessage", {
        chat_id: chatId,
        text: "📥 你的注册申请已提交，并已发送给所有者审核。"
      });
    }

    if (userState.step === "LOGIN_USERNAME") {
      await setKV(`state_${userId}`, { step: "LOGIN_PASSWORD", loginUsername: text });
      return sendTelegram("sendMessage", {
        chat_id: chatId,
        text: "🔐 请输入你的密码："
      });
    }

    if (userState.step === "LOGIN_PASSWORD") {
      const username = userState.loginUsername;
      const password = text;

      const userData = await getKV(`user_uname_${username}`);
      if (userData && userData.approved && (await verifyPassword(password, userData.password))) {
        // 若旧数据是明文密码，登录成功后自动升级为哈希
        if (isLegacyPlain(userData.password)) {
          userData.password = await hashPassword(password);
          await setKV(`user_uname_${username}`, userData);
        }
        await setKV(`session_${userId}`, username);
        await setKV(`state_${userId}`, null);
        return showUserDashboard(chatId, username);
      } else {
        await setKV(`state_${userId}`, null);
        return sendTelegram("sendMessage", {
          chat_id: chatId,
          text: "❌ 用户名或密码错误。"
        });
      }
    }

    if (userState.step === "SUBMIT_API") {
      let userApis = (await getKV(`apis_${userId}`)) || [];
      userApis.push(text.trim());
      await setKV(`apis_${userId}`, userApis);

      await setKV(`state_${userId}`, null);
      return sendTelegram("sendMessage", {
        chat_id: chatId,
        text: "✅ Gemini API 密钥已成功登记并启用！",
        reply_markup: {
          inline_keyboard: [[{ text: "🔙 返回面板", callback_data: "user_dashboard" }]]
        }
      });
    }

    // 频道级独立 API：为指定频道单独绑定一个 Gemini 密钥
    if (userState.step === "SET_CHANNEL_API") {
      const targetChannelId = userState.targetChannelId;
      let userChannels = (await getKV(`channels_${userId}`)) || [];
      const channel = userChannels.find((c) => c.id.toString() === targetChannelId.toString());

      if (!channel) {
        await setKV(`state_${userId}`, null);
        return sendTelegram("sendMessage", {
          chat_id: chatId,
          text: "❌ 未找到该频道，可能已被移除。"
        });
      }

      channel.api = text.trim();
      await setKV(`channels_${userId}`, userChannels);
      await setKV(`state_${userId}`, null);

      return sendTelegram("sendMessage", {
        chat_id: chatId,
        text: `✅ 已为频道 **${channel.title}** 绑定专属 API 密钥！\n该频道的翻译将优先使用此密钥。`,
        parse_mode: "Markdown",
        reply_markup: {
          inline_keyboard: [[{ text: "🔙 返回频道设置", callback_data: `manage_ch_${channel.id}` }]]
        }
      });
    }
  }
}

// ============================================================================
// 4. 处理内联按钮点击 & Gemini 翻译引擎
// ============================================================================

async function handleCallbackQuery(query) {
  const queryId = query.id;
  const data = query.data;
  const userId = query.from.id;
  const chatId = query.message ? query.message.chat.id : userId;
  const messageId = query.message ? query.message.message_id : null;

  if (data.startsWith("setlang_")) {
    const lang = data.split("_")[1];
    await setKV(`lang_${userId}`, lang);
    await answerCallback(queryId, "语言已保存。");

    await sendBotGuide(chatId);

    const isJoined = await checkForceJoin(userId);
    if (!isJoined) return sendForceJoinMessage(chatId);

    return showUserAuthMenu(chatId);
  }

  if (data === "check_force_join") {
    const isJoined = await checkForceJoin(userId);
    if (isJoined) {
      await answerCallback(queryId, "✅ 你的加入已确认！", true);
      return showUserAuthMenu(chatId, messageId);
    } else {
      return answerCallback(queryId, "❌ 你还没有加入频道！", true);
    }
  }

  if (userId !== CONFIG.OWNER_ID) {
    const isJoined = await checkForceJoin(userId);
    if (!isJoined) {
      await answerCallback(queryId, "⚠️ 请先加入相关频道。", true);
      return sendForceJoinMessage(chatId);
    }
  }

  // --- 使用 Gemini API 智能翻译 ---
  if (data.startsWith("tr_")) {
    // callback_data 形如: tr_<lang>_<channelId>_<msgId>
    const parts = data.split("_");
    const targetLangCode = parts[1];

    const originalText = query.message?.text || query.message?.caption || "";
    if (!originalText) {
      return answerCallback(queryId, "未找到可翻译的文本。", true);
    }

    // 频道帖子上的翻译按钮：优先用「频道所有者」登记的 API 密钥，
    // 因为点击者(粉丝)通常没有配置 API。找不到时回退到免费翻译。
    const apiKey = await resolveApiKey(query);

    // 先弹一个提示，避免用户以为没反应（Telegram 要求尽快 answer）
    await answerCallback(queryId, "⏳ 正在翻译，请稍候…", false);

    let translatedText = "";
    try {
      if (apiKey) {
        translatedText = await translateWithGemini(originalText, targetLangCode, apiKey);
      } else {
        translatedText = await fallbackTranslate(originalText, targetLangCode);
      }
    } catch (err) {
      console.error("Gemini Error, using fallback...", err);
      try {
        translatedText = await fallbackTranslate(originalText, targetLangCode);
      } catch (e) {
        return answerCallback(queryId, "❌ 连接翻译服务器时出错。", true);
      }
    }

    // 完整展示译文：以「回复原帖」的形式发送到同一聊天(频道)，
    // 支持任意长度（超过 Telegram 单条 4096 字符时自动分段发送）。
    const langLabel = LANG_LABELS[targetLangCode] || targetLangCode;
    const header = `🌐 <b>${langLabel} 翻译</b>\n\n`;
    const targetChatId = query.message.chat.id;
    const replyToId = query.message.message_id;

    await sendLongMessage(targetChatId, header + escapeHtml(translatedText), replyToId);
    return;
  }

  // 所有者菜单及其他按钮
  if (data === "admin_main" && userId === CONFIG.OWNER_ID) {
    return showAdminPanel(chatId, messageId);
  }

  if (data === "admin_force_join_menu" && userId === CONFIG.OWNER_ID) {
    const fch = await getKV("force_channel");
    const statusText = fch && fch.username ? `📢 当前生效的频道：${fch.username}` : "❌ 尚未设置任何频道。";

    const keyboard = {
      inline_keyboard: [
        [{ text: "➕ 设置 / 更换频道", callback_data: "admin_set_force_ch" }],
        fch ? [{ text: "❌ 取消强制加入", callback_data: "admin_del_force_ch" }] : [],
        [{ text: "🔙 返回面板", callback_data: "admin_main" }]
      ].filter((row) => row.length > 0)
    };

    return editOrSend(chatId, messageId, `⚙️ **强制加入管理：**\n\n${statusText}`, keyboard);
  }

  if (data === "admin_set_force_ch" && userId === CONFIG.OWNER_ID) {
    await setKV(`state_${userId}`, { step: "SET_FORCE_CHANNEL" });
    await answerCallback(queryId, "请发送频道 ID。");
    return sendTelegram("sendMessage", {
      chat_id: chatId,
      text: "📢 请发送频道或群组的公开用户名（带 `@`，例如：`@MyChannel`）："
    });
  }

  if (data === "admin_del_force_ch" && userId === CONFIG.OWNER_ID) {
    await deleteKV("force_channel");
    await answerCallback(queryId, "强制加入已关闭。", true);
    return showAdminPanel(chatId, messageId);
  }

  if (data === "admin_users_menu" && userId === CONFIG.OWNER_ID) {
    const keyboard = {
      inline_keyboard: [
        [{ text: "📥 注册请求", callback_data: "admin_requests" }],
        [{ text: "➕ 添加用户", callback_data: "admin_add_user" }],
        [{ text: "👥 用户列表", callback_data: "admin_list_users" }],
        [{ text: "🔙 返回", callback_data: "admin_main" }]
      ]
    };
    return editOrSend(chatId, messageId, "👥 **用户管理区：**", keyboard);
  }

  if (data === "admin_add_user" && userId === CONFIG.OWNER_ID) {
    await setKV(`state_${userId}`, { step: "ADD_USER_USERNAME" });
    await answerCallback(queryId, "请输入用户名。");
    return sendTelegram("sendMessage", {
      chat_id: chatId,
      text: "👤 请发送新的**用户名**："
    });
  }

  if (data === "admin_list_users" && userId === CONFIG.OWNER_ID) {
    const allUsers = (await getKV("all_users_list")) || [];
    if (allUsers.length === 0) return answerCallback(queryId, "尚未登记任何用户。", true);

    const buttons = allUsers.map((u) => [{ text: `👤 ${u}`, callback_data: `view_u_${u}` }]);
    buttons.push([{ text: "🔙 返回", callback_data: "admin_users_menu" }]);

    return editOrSend(chatId, messageId, "📜 **用户列表：**", { inline_keyboard: buttons });
  }

  if (data.startsWith("view_u_") && userId === CONFIG.OWNER_ID) {
    const targetUser = data.replace("view_u_", "");
    const keyboard = {
      inline_keyboard: [
        [{ text: "🔒 重置该用户密码", callback_data: `reset_pass_${targetUser}` }],
        [{ text: "❌ 删除用户", callback_data: `del_u_${targetUser}` }],
        [{ text: "🔙 返回上一级", callback_data: "admin_list_users" }]
      ]
    };
    return editOrSend(chatId, messageId, `👤 **用户信息：** ${targetUser}\n\n🔐 密码已加密存储，无法查看明文。如遗忘可点击「重置密码」。`, keyboard);
  }

  if (data.startsWith("reset_pass_") && userId === CONFIG.OWNER_ID) {
    const targetUser = data.replace("reset_pass_", "");
    await setKV(`state_${userId}`, { step: "RESET_USER_PASSWORD", targetUsername: targetUser });
    await answerCallback(queryId, "请发送新密码。");
    return sendTelegram("sendMessage", {
      chat_id: chatId,
      text: `🔒 请发送用户 **${targetUser}** 的新密码：`,
      parse_mode: "Markdown"
    });
  }

  if (data.startsWith("del_u_") && userId === CONFIG.OWNER_ID) {
    const targetUser = data.replace("del_u_", "");
    await deleteKV(`user_uname_${targetUser}`);

    let allUsers = (await getKV("all_users_list")) || [];
    allUsers = allUsers.filter((u) => u !== targetUser);
    await setKV("all_users_list", allUsers);

    await answerCallback(queryId, "用户已删除。", true);
    return showAdminPanel(chatId, messageId);
  }

  if (data === "admin_requests" && userId === CONFIG.OWNER_ID) {
    const requests = (await getKV("pending_requests")) || [];
    if (requests.length === 0) return answerCallback(queryId, "没有待处理的请求。", true);

    const buttons = requests.map((r, idx) => [
      { text: `✅ 接受 ${r.username}`, callback_data: `acc_req_${idx}` },
      { text: `❌ 拒绝 ${r.username}`, callback_data: `rej_req_${idx}` }
    ]);
    buttons.push([{ text: "🔙 返回", callback_data: "admin_users_menu" }]);

    return editOrSend(chatId, messageId, "📥 **注册请求：**", { inline_keyboard: buttons });
  }

  if (data.startsWith("acc_req_") && userId === CONFIG.OWNER_ID) {
    const idx = parseInt(data.replace("acc_req_", ""));
    let requests = (await getKV("pending_requests")) || [];
    const req = requests[idx];

    if (req) {
      const userObj = { username: req.username, password: req.password, approved: true };
      await setKV(`user_uname_${req.username}`, userObj);

      let allUsers = (await getKV("all_users_list")) || [];
      if (!allUsers.includes(req.username)) allUsers.push(req.username);
      await setKV("all_users_list", allUsers);

      requests.splice(idx, 1);
      await setKV("pending_requests", requests);

      try {
        await sendTelegram("sendMessage", {
          chat_id: req.userId,
          text: "✅ **你的注册申请已被所有者通过！** 现在可以登录面板了。"
        });
      } catch (e) {}

      await answerCallback(queryId, `请求 ${req.username} 已通过。`, true);
      return showAdminPanel(chatId, messageId);
    }
  }

  // 拒绝注册请求
  if (data.startsWith("rej_req_") && userId === CONFIG.OWNER_ID) {
    const idx = parseInt(data.replace("rej_req_", ""));
    let requests = (await getKV("pending_requests")) || [];
    const req = requests[idx];

    if (req) {
      requests.splice(idx, 1);
      await setKV("pending_requests", requests);

      try {
        await sendTelegram("sendMessage", {
          chat_id: req.userId,
          text: "❌ 很抱歉，你的注册申请已被所有者拒绝。"
        });
      } catch (e) {}

      await answerCallback(queryId, `请求 ${req.username} 已拒绝。`, true);
      return showAdminPanel(chatId, messageId);
    } else {
      return answerCallback(queryId, "该请求已不存在。", true);
    }
  }

  // --- 用户部分 ---
  if (data === "user_auth_request") {
    await setKV(`state_${userId}`, { step: "REQ_USERNAME" });
    await answerCallback(queryId, "请发送用户名。");
    return sendTelegram("sendMessage", {
      chat_id: chatId,
      text: "👤 请发送你想要的**用户名**："
    });
  }

  if (data === "user_auth_login") {
    await setKV(`state_${userId}`, { step: "LOGIN_USERNAME" });
    await answerCallback(queryId, "请输入用户名。");
    return sendTelegram("sendMessage", {
      chat_id: chatId,
      text: "👤 请输入你的**用户名**："
    });
  }

  if (data === "user_dashboard") {
    return showUserDashboard(chatId, "用户", messageId);
  }

  if (data === "user_channels_menu") {
    const userChannels = (await getKV(`channels_${userId}`)) || [];

    if (userChannels.length === 0) {
      const keyboard = {
        inline_keyboard: [
          [{ text: "➕ 添加频道指南", callback_data: "how_add_channel" }],
          [{ text: "🔙 返回", callback_data: "user_dashboard" }]
        ]
      };
      return editOrSend(
        chatId,
        messageId,
        "📢 **你还没有登记任何频道！**\n\n要添加频道，只需把机器人在你的频道里设为**管理员 (Admin)** 即可。",
        keyboard
      );
    }

    const buttons = userChannels.map((c) => [
      { text: `📢 ${c.title}`, callback_data: `manage_ch_${c.id}` }
    ]);
    buttons.push([{ text: "➕ 添加新频道指南", callback_data: "how_add_channel" }]);
    buttons.push([{ text: "🔙 返回", callback_data: "user_dashboard" }]);

    return editOrSend(chatId, messageId, "📢 **你的活跃频道：**", { inline_keyboard: buttons });
  }

  if (data === "how_add_channel") {
    const keyboard = {
      inline_keyboard: [[{ text: "🔙 返回", callback_data: "user_channels_menu" }]]
    };
    return editOrSend(
      chatId,
      messageId,
      "📌 **为指定帖子启用翻译的指南：**\n\n1. 把机器人在频道里设为管理员。\n2. 把你想加翻译按钮的任意频道帖子，**转发到机器人的私聊**。\n3. 机器人会立即在你频道的那条帖子下方启用翻译按钮！",
      keyboard
    );
  }

  if (data.startsWith("manage_ch_")) {
    const channelId = data.replace("manage_ch_", "");
    const userChannels = (await getKV(`channels_${userId}`)) || [];
    const channel = userChannels.find((c) => c.id.toString() === channelId);

    if (!channel) return answerCallback(queryId, "未找到该频道。", true);

    const rows = [
      [{ text: "🔑 连接 / 更换该频道的 API", callback_data: `set_ch_api_${channel.id}` }]
    ];
    if (channel.api) {
      rows.push([{ text: "❌ 移除该频道的专属 API", callback_data: `del_ch_api_${channel.id}` }]);
    }
    rows.push([{ text: "🔙 返回频道列表", callback_data: "user_channels_menu" }]);

    const apiStatus = channel.api ? "✅ 已绑定专属 API" : "❌ 无专属 API（将使用你账户的默认 API）";

    return editOrSend(
      chatId,
      messageId,
      `📢 **频道设置：** ${channel.title}\n\nAPI 状态：${apiStatus}`,
      { inline_keyboard: rows }
    );
  }

  // 为某频道设置专属 API：进入输入状态
  if (data.startsWith("set_ch_api_")) {
    const targetChannelId = data.replace("set_ch_api_", "");
    const userChannels = (await getKV(`channels_${userId}`)) || [];
    const channel = userChannels.find((c) => c.id.toString() === targetChannelId);
    if (!channel) return answerCallback(queryId, "未找到该频道。", true);

    await setKV(`state_${userId}`, { step: "SET_CHANNEL_API", targetChannelId });
    await answerCallback(queryId, "请发送该频道专属的 API 密钥。");
    return sendTelegram("sendMessage", {
      chat_id: chatId,
      text: `🔑 请发送要绑定到频道 **${channel.title}** 的 Gemini API 密钥：`,
      parse_mode: "Markdown"
    });
  }

  // 移除某频道的专属 API
  if (data.startsWith("del_ch_api_")) {
    const targetChannelId = data.replace("del_ch_api_", "");
    let userChannels = (await getKV(`channels_${userId}`)) || [];
    const channel = userChannels.find((c) => c.id.toString() === targetChannelId);
    if (!channel) return answerCallback(queryId, "未找到该频道。", true);

    channel.api = null;
    await setKV(`channels_${userId}`, userChannels);
    await answerCallback(queryId, "该频道的专属 API 已移除。", true);
    return editOrSend(
      chatId,
      messageId,
      `📢 **频道设置：** ${channel.title}\n\nAPI 状态：❌ 无专属 API（将使用你账户的默认 API）`,
      {
        inline_keyboard: [
          [{ text: "🔑 连接 / 更换该频道的 API", callback_data: `set_ch_api_${channel.id}` }],
          [{ text: "🔙 返回频道列表", callback_data: "user_channels_menu" }]
        ]
      }
    );
  }

  if (data === "user_api_menu") {
    const userApis = (await getKV(`apis_${userId}`)) || [];
    const hasApi = userApis.length > 0;

    const keyboard = {
      inline_keyboard: [
        [{ text: "➕ 登记新 API", callback_data: "user_add_api" }],
        hasApi ? [{ text: "❌ 删除全部 API", callback_data: "user_del_api" }] : [],
        [{ text: "🔙 返回", callback_data: "user_dashboard" }]
      ].filter((row) => row.length > 0)
    };

    const statusText = hasApi ? `✅ 你已启用的 API 数量：${userApis.length}` : "❌ 你还没有登记任何 API。";

    return editOrSend(chatId, messageId, `🔑 **你的 API 管理：**\n\n${statusText}`, keyboard);
  }

  if (data === "user_add_api") {
    await setKV(`state_${userId}`, { step: "SUBMIT_API" });
    await answerCallback(queryId, "请发送 API 密钥。");
    return sendTelegram("sendMessage", {
      chat_id: chatId,
      text: "🔑 请发送你的 **Gemini API 密钥**："
    });
  }

  if (data === "user_del_api") {
    await deleteKV(`apis_${userId}`);
    await answerCallback(queryId, "你的全部 API 已清除。", true);
    return showUserDashboard(chatId, "用户", messageId);
  }
}

// ============================================================================
// 5. Gemini API 专用翻译函数
// ============================================================================

// 语言代码 -> 显示名称（用于译文标题）
const LANG_LABELS = {
  zh: "🇨🇳 中文",
  fa: "🇮🇷 فارسی",
  en: "🇬🇧 English",
  ru: "🇷🇺 Русский"
};

// 解析要使用的 API 密钥：
// 频道帖子上的翻译按钮，点击者往往是粉丝(没有 API)，
// 因此优先查频道所有者登记的密钥；找不到再用点击者自己的。
async function resolveApiKey(query) {
  const clickerId = query.from.id;

  // 频道消息的 chat.id 即频道 ID，可据此直接定位频道所有者
  const channelId = query.message?.chat?.id;

  if (channelId) {
    const ownerId = await getKV(`channel_owner_${channelId}`);
    if (ownerId) {
      // 1) 优先使用该频道绑定的「专属 API」
      const ownerChannels = (await getKV(`channels_${ownerId}`)) || [];
      const ch = ownerChannels.find((c) => c.id === channelId);
      if (ch && ch.api) return ch.api;

      // 2) 其次使用频道所有者账户的默认 API
      const ownerApis = (await getKV(`apis_${ownerId}`)) || [];
      if (ownerApis.length > 0) return ownerApis[0];
    }
  }

  // 3) 最后回退到点击者自己的 API
  const clickerApis = (await getKV(`apis_${clickerId}`)) || [];
  return clickerApis.length > 0 ? clickerApis[0] : null;
}

async function translateWithGemini(text, targetLang, apiKey) {
  const targetLanguages = {
    zh: "Simplified Chinese (简体中文)",
    fa: "Persian",
    en: "English",
    ru: "Russian"
  };

  const langName = targetLanguages[targetLang] || "Simplified Chinese (简体中文)";

  const url = `https://generativelanguage.googleapis.com/v1beta/models/gemini-1.5-flash:generateContent?key=${apiKey}`;

  const response = await fetch(url, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      contents: [
        {
          parts: [
            {
              text: `Translate the following text accurately to ${langName}. Return ONLY the translated text without any explanations or intro:\n\n${text}`
            }
          ]
        }
      ]
    })
  });

  if (!response.ok) {
    throw new Error(`Gemini API Error: ${response.status}`);
  }

  const data = await response.json();
  const translated = data.candidates?.[0]?.content?.parts?.[0]?.text;

  if (!translated) {
    throw new Error("Invalid response structure from Gemini API");
  }

  return translated.trim();
}

async function fallbackTranslate(text, targetLang) {
  // Google 免费翻译接口对中文使用 zh-CN 语言代码
  const codeMap = { zh: "zh-CN" };
  const tl = codeMap[targetLang] || targetLang;

  const url = `https://translate.googleapis.com/translate_a/single?client=gtx&sl=auto&tl=${tl}&dt=t&q=${encodeURIComponent(text)}`;
  const response = await fetch(url, { headers: { "User-Agent": "Mozilla/5.0" } });
  if (!response.ok) throw new Error("Translation failed");
  const result = await response.json();
  return result[0].map((item) => item[0]).join("");
}

// ============================================================================
// 6. 消息发送与界面辅助函数
// ============================================================================

async function sendBotGuide(chatId) {
  const guideText =
`✨ **欢迎使用 Yaraav 智能机器人！**

使用本机器人，你可以让自己的频道变得智能，为观众提供把帖子自动翻译成多种语言的功能。

---

📖 **功能概览：**
1️⃣ **频道管理：** 只需把机器人在你的频道里设为管理员，即可被自动识别。
2️⃣ **按需翻译：** 要给某条帖子加翻译按钮，只需**把该帖子转发到机器人私聊**。
3️⃣ **专属 API 管理：** 为了更快的速度，你可以设置自己的免费 Gemini API 密钥。

---

🔑 **快速获取免费 Gemini API 教程：**
1. 打开 [Google AI Studio](https://aistudio.google.com)。
2. 用 Google 账号登录。
3. 点击 **Get API key** 按钮。
4. 选择 **Create API key**，把复制到的密钥发送到机器人的 **API** 区域即可！`;

  await sendTelegram("sendMessage", {
    chat_id: chatId,
    text: guideText,
    parse_mode: "Markdown",
    disable_web_page_preview: true
  });
}

async function sendForceJoinMessage(chatId) {
  const fch = await getKV("force_channel");
  if (!fch || !fch.username) {
    // 频道未设置时的兜底，避免读取 null 报错
    return sendTelegram("sendMessage", {
      chat_id: chatId,
      text: "⚠️ 强制加入频道尚未配置，请稍后再试。"
    });
  }

  const channelLink = fch.username.startsWith("@")
    ? `https://t.me/${fch.username.replace("@", "")}`
    : fch.username;

  const keyboard = {
    inline_keyboard: [
      [{ text: "📢 加入频道", url: channelLink }],
      [{ text: "🔄 我已加入（检查）", callback_data: "check_force_join" }]
    ]
  };

  return sendTelegram("sendMessage", {
    chat_id: chatId,
    text: "⚠️ **使用本机器人前，请先加入下面的频道：**\n\n加入后，点击 **「我已加入」** 按钮。",
    reply_markup: keyboard
  });
}

async function showAdminPanel(chatId, messageId = null) {
  const keyboard = {
    inline_keyboard: [
      [{ text: "👥 用户管理", callback_data: "admin_users_menu" }],
      [{ text: "📢 设置强制加入", callback_data: "admin_force_join_menu" }],
      [{ text: "⚙️ 我的面板（个人设置）", callback_data: "user_dashboard" }]
    ]
  };

  return editOrSend(chatId, messageId, "🔥 **欢迎，尊敬的所有者！Yaraav 管理面板：**", keyboard);
}

async function showLanguageSelection(chatId) {
  const keyboard = {
    inline_keyboard: [
      [
        { text: "🇨🇳 中文", callback_data: "setlang_zh" },
        { text: "🇬🇧 English", callback_data: "setlang_en" }
      ],
      [
        { text: "🇮🇷 فارسی", callback_data: "setlang_fa" }
      ]
    ]
  };
  return sendTelegram("sendMessage", {
    chat_id: chatId,
    text: "🌐 请选择你的语言 / Please select your language：",
    reply_markup: keyboard
  });
}

async function showUserAuthMenu(chatId, messageId = null) {
  const keyboard = {
    inline_keyboard: [
      [{ text: "🔑 登录面板", callback_data: "user_auth_login" }],
      [{ text: "📝 申请注册", callback_data: "user_auth_request" }]
    ]
  };
  return editOrSend(chatId, messageId, "✨ 欢迎使用 **Yaraav** 机器人。请选择你需要的操作：", keyboard);
}

async function showUserDashboard(chatId, username, messageId = null) {
  const keyboard = {
    inline_keyboard: [
      [{ text: "📢 频道管理", callback_data: "user_channels_menu" }],
      [{ text: "🔑 API", callback_data: "user_api_menu" }],
      [{ text: "🔙 返回主菜单", callback_data: "admin_main" }]
    ]
  };
  return editOrSend(chatId, messageId, `🎉 **你的用户面板：**`, keyboard);
}

async function getKV(key) {
  try {
    const val = await YARAAV_DB.get(key);
    return val ? JSON.parse(val) : null;
  } catch {
    return null;
  }
}

async function setKV(key, value) {
  return await YARAAV_DB.put(key, JSON.stringify(value));
}

async function deleteKV(key) {
  return await YARAAV_DB.delete(key);
}

async function editOrSend(chatId, messageId, text, keyboard) {
  if (messageId) {
    return sendTelegram("editMessageText", {
      chat_id: chatId,
      message_id: messageId,
      text: text,
      parse_mode: "Markdown",
      reply_markup: keyboard
    });
  } else {
    return sendTelegram("sendMessage", {
      chat_id: chatId,
      text: text,
      parse_mode: "Markdown",
      reply_markup: keyboard
    });
  }
}

async function answerCallback(queryId, text, showAlert = false) {
  return sendTelegram("answerCallbackQuery", {
    callback_query_id: queryId,
    text: text,
    show_alert: showAlert
  });
}

async function sendTelegram(method, body) {
  const url = `https://api.telegram.org/bot${CONFIG.TELEGRAM_TOKEN}/${method}`;
  const response = await fetch(url, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body)
  });
  return response.json();
}

// HTML 转义，防止译文里的 < > & 破坏 parse_mode=HTML
function escapeHtml(str) {
  return String(str)
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;");
}

// 发送任意长度文本：超过 Telegram 单条消息 4096 字符上限时自动分段。
// header 里的 <b> 等标签只放在第一段，避免跨段截断标签。
async function sendLongMessage(chatId, fullText, replyToMessageId = null) {
  const MAX = 4000; // 留出余量，Telegram 上限约 4096

  if (fullText.length <= MAX) {
    return sendTelegram("sendMessage", {
      chat_id: chatId,
      text: fullText,
      parse_mode: "HTML",
      disable_web_page_preview: true,
      ...(replyToMessageId ? { reply_to_message_id: replyToMessageId } : {})
    });
  }

  // 按长度切分为多段，尽量在换行处断开
  const chunks = [];
  let rest = fullText;
  while (rest.length > MAX) {
    let cut = rest.lastIndexOf("\n", MAX);
    if (cut < MAX * 0.5) cut = MAX; // 找不到合适换行就硬切
    chunks.push(rest.slice(0, cut));
    rest = rest.slice(cut);
  }
  if (rest.length) chunks.push(rest);

  let lastRes;
  for (let i = 0; i < chunks.length; i++) {
    lastRes = await sendTelegram("sendMessage", {
      chat_id: chatId,
      text: chunks[i],
      parse_mode: "HTML",
      disable_web_page_preview: true,
      // 仅首段回复原帖，减少刷屏
      ...(i === 0 && replyToMessageId ? { reply_to_message_id: replyToMessageId } : {})
    });
  }
  return lastRes;
}
