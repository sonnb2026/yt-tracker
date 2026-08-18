// api/manage-channels.js
//
// Lets the "Quản lý kênh" panel on the site add/remove a channel, or
// add/remove an entire tab, WITHOUT anyone having to open GitHub or edit
// channels.json by hand. It reads channels.json from the repo via GitHub's
// Contents API, edits it in memory, and commits it straight back - which
// then triggers the existing `push: paths: channels.json` rule in
// fetch-data.yml, so new channels get fetched automatically within a few
// minutes without any extra step.
//
// No password on this endpoint either (matches trigger-fetch.js) - anyone
// who can load the site can manage channels/tabs. If that's ever a concern,
// the simplest fix is restricting who knows the site's URL, since neither
// endpoint exposes any secret to the browser.
//
// Required environment variables (same ones trigger-fetch.js uses):
//   GITHUB_TOKEN   Needs "Contents: Read and write" (để sửa channels.json)
//                  VÀ "Actions: Read and write" (để tự dispatch fetch giới
//                  hạn only_channels/only_list ngay sau khi thêm kênh - xem
//                  dispatchOnlyChannelsFetch bên dưới). Một classic PAT với
//                  scope "repo" đã có đủ cả 2 quyền này.
//   GITHUB_OWNER
//   GITHUB_REPO
// Optional:
//   GITHUB_REF             fallback thủ công, chỉ dùng khi VERCEL_GIT_COMMIT_REF
//                          (Vercel tự cấp, đúng nhánh deploy hiện tại) không có sẵn.
//                          Mặc định cuối cùng "main" nếu cả 2 đều thiếu.
//   GITHUB_WORKFLOW_FILE   defaults to "fetch-data.yml" (tên workflow để dispatch)

module.exports = async function handler(req, res) {
  if (req.method !== "POST") {
    res.setHeader("Allow", "POST");
    return res.status(405).json({ error: "Method not allowed" });
  }

  const token = process.env.GITHUB_TOKEN;
  const owner = process.env.GITHUB_OWNER;
  const repo = process.env.GITHUB_REPO;
  const missing = ["GITHUB_TOKEN", "GITHUB_OWNER", "GITHUB_REPO"].filter((k) => !process.env[k]);
  if (missing.length) {
    return res.status(500).json({
      error: `Server chưa cấu hình đủ biến môi trường: ${missing.join(", ")} (vào Vercel Settings > Environment Variables).`,
    });
  }
  // Ưu tiên VERCEL_GIT_COMMIT_REF - biến Vercel TỰ ĐỘNG cấp cho mọi deploy,
  // đúng bằng tên nhánh của chính bản deploy đang chạy. Nhờ vậy sửa
  // channels.json / dispatch fetch từ 1 preview deploy (nhánh review) sẽ
  // ghi/dispatch đúng trên nhánh đó, không bị lệch sang main như khi dùng
  // GITHUB_REF cố định (xem cùng logic trong trigger-fetch.js).
  const ref = process.env.VERCEL_GIT_COMMIT_REF || process.env.GITHUB_REF || "main";

  const body = typeof req.body === "string" ? safeJsonParse(req.body) : req.body || {};
  const { action, tab, channel, newTab } = body;

  // "channel" có thể là 1 link/@handle, hoặc nhiều dòng/nhiều link cách nhau
  // bằng dấu phẩy (khi người dùng dán nhiều kênh cùng lúc vào ô textarea).
  const channelList =
    typeof channel === "string"
      ? channel
          .split(/[\n,]+/)
          .map((c) => c.trim())
          .filter(Boolean)
      : [];

  if (!["addChannel", "removeChannel", "addTab", "removeTab", "renameTab", "listTabs"].includes(action)) {
    return res.status(400).json({ error: "Thiếu hoặc sai 'action'." });
  }
  if (action !== "listTabs" && (!tab || typeof tab !== "string" || !tab.trim())) {
    return res.status(400).json({ error: "Thiếu tên tab." });
  }
  if ((action === "addChannel" || action === "addTab") && channelList.length === 0) {
    return res.status(400).json({ error: "Thiếu link/handle kênh." });
  }
  if (action === "renameTab" && (!newTab || typeof newTab !== "string" || !newTab.trim())) {
    return res.status(400).json({ error: "Thiếu tên tab mới." });
  }
  // Tên tab được dùng thẳng trong tên file (videos-<tab>.json) nên không được
  // chứa dấu / hoặc \ - tránh vô tình tạo nhầm đường dẫn thư mục.
  if (action === "addTab" && /[\\/]/.test(tab)) {
    return res.status(400).json({ error: "Tên tab không được chứa dấu / hoặc \\." });
  }
  if (action === "renameTab" && /[\\/]/.test(newTab)) {
    return res.status(400).json({ error: "Tên tab mới không được chứa dấu / hoặc \\." });
  }

  const ghHeaders = {
    Authorization: `Bearer ${token}`,
    Accept: "application/vnd.github+json",
    "X-GitHub-Api-Version": "2022-11-28",
  };
  const contentsUrl = `https://api.github.com/repos/${owner}/${repo}/contents/channels.json`;

  try {
    // 1. Đọc channels.json hiện tại.
    const getRes = await fetch(`${contentsUrl}?ref=${ref}`, { headers: ghHeaders });
    if (!getRes.ok) {
      const t = await getRes.text();
      return res.status(502).json({ error: `Không đọc được channels.json (HTTP ${getRes.status}): ${t.slice(0, 300)}` });
    }
    const file = await getRes.json();
    const sha = file.sha;
    let current = JSON.parse(Buffer.from(file.content, "base64").toString("utf-8"));

    if (action === "listTabs") {
      return res.status(200).json({ ok: true, channels: current });
    }

    const tabKey = tab.trim();
    let commitMessage = "";

    if (action === "addTab") {
      if (current[tabKey]) {
        return res.status(409).json({ error: `Tab "${tabKey}" đã tồn tại rồi.` });
      }
      // Loại trùng lặp trong chính danh sách vừa dán vào.
      const deduped = [];
      for (const c of channelList) {
        if (!deduped.some((d) => d.toLowerCase() === c.toLowerCase())) deduped.push(c);
      }
      current[tabKey] = deduped;
      commitMessage = `chore: thêm tab "${tabKey}" (${deduped.length} kênh) qua web`;
    } else if (action === "removeTab") {
      if (!current[tabKey]) {
        return res.status(404).json({ error: `Không tìm thấy tab "${tabKey}".` });
      }
      delete current[tabKey];
      commitMessage = `chore: xoá tab "${tabKey}" qua web`;
    } else if (action === "renameTab") {
      if (!current[tabKey]) {
        return res.status(404).json({ error: `Không tìm thấy tab "${tabKey}".` });
      }
      const newKey = newTab.trim();
      if (newKey.toLowerCase() === tabKey.toLowerCase()) {
        return res.status(400).json({ error: "Tên tab mới trùng với tên hiện tại." });
      }
      if (current[newKey]) {
        return res.status(409).json({ error: `Tab "${newKey}" đã tồn tại rồi.` });
      }
      // Dựng lại object để giữ đúng thứ tự tab, chỉ đổi key của tab đang sửa.
      const rebuilt = {};
      for (const [k, v] of Object.entries(current)) {
        rebuilt[k === tabKey ? newKey : k] = v;
      }
      current = rebuilt;
      commitMessage = `chore: đổi tên tab "${tabKey}" thành "${newKey}" qua web`;
    } else if (action === "addChannel") {
      if (!current[tabKey]) {
        return res.status(404).json({ error: `Không tìm thấy tab "${tabKey}".` });
      }
      const existingLower = current[tabKey].map((c) => c.toLowerCase());
      const toAdd = [];
      for (const c of channelList) {
        if (existingLower.includes(c.toLowerCase())) continue; // đã có trong tab, bỏ qua
        if (toAdd.some((d) => d.toLowerCase() === c.toLowerCase())) continue; // trùng trong chính danh sách vừa dán
        toAdd.push(c);
      }
      if (toAdd.length === 0) {
        return res.status(409).json({ error: "Kênh (hoặc tất cả các kênh) này đã có trong tab rồi." });
      }
      current[tabKey].push(...toAdd);
      commitMessage =
        toAdd.length === 1
          ? `chore: thêm kênh vào tab "${tabKey}" qua web`
          : `chore: thêm ${toAdd.length} kênh vào tab "${tabKey}" qua web`;
    } else if (action === "removeChannel") {
      if (!current[tabKey]) {
        return res.status(404).json({ error: `Không tìm thấy tab "${tabKey}".` });
      }
      const clean = channel.trim().toLowerCase();
      const before = current[tabKey].length;
      current[tabKey] = current[tabKey].filter((c) => c.toLowerCase() !== clean);
      if (current[tabKey].length === before) {
        return res.status(404).json({ error: "Không tìm thấy kênh này trong tab." });
      }
      commitMessage = `chore: xoá kênh khỏi tab "${tabKey}" qua web`;
    }

    // 2. Best-effort: giữ lại dữ liệu cũ khi đổi tên tab (đổi tên luôn file
    // videos-<tab>.json / meta-<tab>.json / channel-map-<tab>.json), hoặc dọn
    // dẹp cả 3 file này khi xoá tab. Nếu file chưa tồn tại (tab mới, chưa
    // fetch lần nào) thì bỏ qua, không tính là lỗi.
    //
    // Vẫn làm bước này TRƯỚC khi commit channels.json ở bước 3 (dù giờ
    // channels.json không còn trigger workflow qua `push` nữa, nên rủi ro
    // race-condition với 1 job đang chạy song song không còn như trước) -
    // đơn giản là để nếu addChannel/addTab dispatch fetch ngay sau đó (bước
    // 4), file dữ liệu đã ở tên đúng trước khi workflow chạy.
    if (action === "renameTab") {
      const newKey = newTab.trim();
      await renameDataFile(`videos-${tabKey}.json`, `videos-${newKey}.json`, ghHeaders, owner, repo, ref);
      await renameDataFile(`meta-${tabKey}.json`, `meta-${newKey}.json`, ghHeaders, owner, repo, ref);
      await renameDataFile(`channel-map-${tabKey}.json`, `channel-map-${newKey}.json`, ghHeaders, owner, repo, ref);
    } else if (action === "removeTab") {
      await deleteDataFile(`videos-${tabKey}.json`, ghHeaders, owner, repo, ref);
      await deleteDataFile(`meta-${tabKey}.json`, ghHeaders, owner, repo, ref);
      await deleteDataFile(`channel-map-${tabKey}.json`, ghHeaders, owner, repo, ref);
    }

    // 3. Ghi channels.json mới lên GitHub. Commit này KHÔNG còn tự kích hoạt
    // workflow nữa (đã bỏ trigger `push: paths: channels.json` khỏi
    // fetch-data.yml) - việc dispatch fetch (nếu cần) làm tường minh ở bước 4.
    const newContent = Buffer.from(JSON.stringify(current, null, 2) + "\n", "utf-8").toString("base64");
    const putRes = await fetch(contentsUrl, {
      method: "PUT",
      headers: { ...ghHeaders, "Content-Type": "application/json" },
      body: JSON.stringify({
        message: commitMessage,
        content: newContent,
        sha,
        branch: ref,
      }),
    });

    if (!putRes.ok) {
      const t = await putRes.text();
      return res.status(502).json({ error: `Không ghi được channels.json (HTTP ${putRes.status}): ${t.slice(0, 300)}` });
    }

    // 4. Chỉ khi thêm kênh/tab mới mới cần fetch ngay - dispatch workflow
    // giới hạn đúng (các) kênh vừa thêm, không đụng tới kênh nào khác trong
    // tab (xem dispatchOnlyChannelsFetch ở trên). Xoá/đổi tên kênh hoặc tab
    // không cần fetch ngay lập tức nên không dispatch gì thêm ở đây - việc
    // dọn dữ liệu tương ứng sẽ tự xảy ra ở lần cron hàng ngày kế tiếp, hoặc
    // khi ai đó bấm "Fetch dữ liệu" thủ công.
    let dispatched = false;
    if (action === "addChannel") {
      dispatched = await dispatchOnlyChannelsFetch({
        owner,
        repo,
        ref,
        token,
        onlyList: tabKey,
        onlyChannels: toAdd.join(","),
      });
    } else if (action === "addTab") {
      dispatched = await dispatchOnlyChannelsFetch({
        owner,
        repo,
        ref,
        token,
        onlyList: tabKey,
        onlyChannels: deduped.join(","),
      });
    }

    return res.status(200).json({
      ok: true,
      channels: current,
      dispatched,
      message:
        action === "addChannel" || action === "addTab"
          ? dispatched
            ? "Đã thêm! Đang lấy dữ liệu riêng cho kênh vừa thêm (không đụng tới kênh khác), vài phút nữa tải lại trang để xem."
            : "Đã thêm, nhưng không tự kích hoạt fetch được - bấm nút \"Fetch dữ liệu\" để lấy dữ liệu kênh mới."
          : "Đã lưu thay đổi. Dữ liệu liên quan sẽ được dọn ở lần fetch tiếp theo (cron hàng ngày, hoặc bấm \"Fetch dữ liệu\" để chạy ngay).",
    });
  } catch (err) {
    return res.status(500).json({ error: `Lỗi: ${err.message}` });
  }
};

function safeJsonParse(str) {
  try {
    return JSON.parse(str);
  } catch {
    return {};
  }
}

// Kích hoạt workflow fetch-data.yml nhưng giới hạn CHỈ (các) kênh vừa thêm
// (only_channels) trong đúng 1 tab (only_list) - thay vì để trigger `push`
// cũ tự fetch lại TOÀN BỘ mọi kênh trong tab mỗi khi channels.json đổi (tốn
// quota oan cho những kênh không hề thay đổi gì). Kênh mới luôn được
// fetch-data.mjs tự động lấy full history ngay lần đầu (xem isNewChannel
// trong scripts/fetch-data.mjs) nên không cần truyền thêm full_history_channels
// ở đây. Best-effort: nếu dispatch lỗi, channels.json vẫn đã commit thành
// công - người dùng có thể tự bấm "Fetch dữ liệu" để lấy dữ liệu kênh mới.
async function dispatchOnlyChannelsFetch({ owner, repo, ref, token, onlyList, onlyChannels }) {
  const workflowFile = process.env.GITHUB_WORKFLOW_FILE || "fetch-data.yml";
  try {
    const res = await fetch(
      `https://api.github.com/repos/${owner}/${repo}/actions/workflows/${workflowFile}/dispatches`,
      {
        method: "POST",
        headers: {
          Authorization: `Bearer ${token}`,
          Accept: "application/vnd.github+json",
          "X-GitHub-Api-Version": "2022-11-28",
          "Content-Type": "application/json",
        },
        body: JSON.stringify({
          ref,
          inputs: {
            force_refresh_comments: "false",
            full_channel_history: "false",
            full_history_channels: "",
            only_channels: onlyChannels,
            only_list: onlyList,
          },
        }),
      }
    );
    return res.status === 204;
  } catch {
    return false;
  }
}

// Đọc 1 file trong public/data/, ghi nó sang đường dẫn mới, rồi xoá file cũ.
// Im lặng bỏ qua nếu file cũ không tồn tại (chưa fetch lần nào) hoặc có lỗi -
// đây chỉ là tiện ích giữ dữ liệu, không phải bước bắt buộc để đổi tên tab.
async function renameDataFile(oldName, newName, ghHeaders, owner, repo, ref) {
  try {
    const base = `https://api.github.com/repos/${owner}/${repo}/contents/public/data`;
    const getRes = await fetch(`${base}/${oldName}?ref=${ref}`, { headers: ghHeaders });
    if (!getRes.ok) return; // không có file cũ, không sao cả
    const file = await getRes.json();

    // file.content có thể thiếu nếu file cũ quá lớn (Contents API GET không
    // trả về content cho file lớn) - trong trường hợp đó KHÔNG được xoá file
    // cũ ở dưới, nếu không dữ liệu sẽ mất trắng mà không có file mới thay thế.
    if (typeof file.content !== "string") return;

    const putRes = await fetch(`${base}/${newName}`, {
      method: "PUT",
      headers: { ...ghHeaders, "Content-Type": "application/json" },
      body: JSON.stringify({
        message: `chore: đổi tên ${oldName} thành ${newName} qua web`,
        content: file.content,
        branch: ref,
      }),
    });
    // Chỉ xoá file cũ nếu file mới đã tạo thành công - tránh mất dữ liệu nếu
    // PUT thất bại (rate limit, lỗi mạng, v.v.).
    if (!putRes.ok) return;

    await fetch(`${base}/${oldName}`, {
      method: "DELETE",
      headers: { ...ghHeaders, "Content-Type": "application/json" },
      body: JSON.stringify({
        message: `chore: xoá ${oldName} (đã đổi tên) qua web`,
        sha: file.sha,
        branch: ref,
      }),
    });
  } catch {
    // Bỏ qua - dữ liệu sẽ tự tạo lại đúng tên mới ở lần fetch tiếp theo.
  }
}

async function deleteDataFile(name, ghHeaders, owner, repo, ref) {
  try {
    const base = `https://api.github.com/repos/${owner}/${repo}/contents/public/data`;
    const getRes = await fetch(`${base}/${name}?ref=${ref}`, { headers: ghHeaders });
    if (!getRes.ok) return;
    const file = await getRes.json();
    await fetch(`${base}/${name}`, {
      method: "DELETE",
      headers: { ...ghHeaders, "Content-Type": "application/json" },
      body: JSON.stringify({
        message: `chore: xoá ${name} (tab đã bị xoá) qua web`,
        sha: file.sha,
        branch: ref,
      }),
    });
  } catch {
    // Bỏ qua - không nghiêm trọng, chỉ là rác dữ liệu không dùng tới nữa.
  }
}
