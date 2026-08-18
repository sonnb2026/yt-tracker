// api/trigger-fetch.js
//
// Endpoint that kicks off the "Fetch YouTube Data" GitHub Action
// (scripts/fetch-data.mjs) on demand, instead of waiting for the scheduled
// cron. The actual fetch + git commit still happens inside GitHub Actions
// (this function has no persistent filesystem to write to on Vercel) - this
// endpoint just calls GitHub's workflow_dispatch API. No password required -
// anyone who can load the site can click the fetch button.
//
// Required environment variables (set these in the Vercel project's
// Settings -> Environment Variables). There are deliberately NO hardcoded
// fallback values - every deployment (including copies of this project)
// must set its own, so a fresh copy can never accidentally dispatch
// workflows on someone else's repo:
//   GITHUB_TOKEN             A GitHub Personal Access Token with permission
//                            to dispatch workflows on the repo (classic PAT
//                            with the "repo" + "workflow" scopes, or a
//                            fine-grained PAT with "Actions: Read and write"
//                            on this repo). NEVER expose this token to the
//                            browser - it must only live here.
//   GITHUB_OWNER             GitHub username/org that owns the repo.
//   GITHUB_REPO              Repo name.
//
// Optional:
//   GITHUB_WORKFLOW_FILE     defaults to "fetch-data.yml"
//   GITHUB_REF               fallback thủ công, chỉ dùng khi VERCEL_GIT_COMMIT_REF
//                             (Vercel tự cấp, đúng nhánh deploy hiện tại) không có sẵn.
//                             Mặc định cuối cùng "main" nếu cả 2 đều thiếu.

module.exports = async function handler(req, res) {
  if (req.method !== "POST") {
    res.setHeader("Allow", "POST");
    return res.status(405).json({ error: "Method not allowed" });
  }

  const body = typeof req.body === "string" ? safeJsonParse(req.body) : req.body || {};
  const { forceRefreshComments, fullChannelHistory, fullHistoryChannels, onlyChannels, onlyList } = body;

  const token = process.env.GITHUB_TOKEN;
  const owner = process.env.GITHUB_OWNER;
  const repo = process.env.GITHUB_REPO;
  const missing = ["GITHUB_TOKEN", "GITHUB_OWNER", "GITHUB_REPO"].filter((k) => !process.env[k]);
  if (missing.length) {
    return res.status(500).json({
      error: `Server chưa cấu hình đủ biến môi trường: ${missing.join(", ")} (vào Vercel Settings > Environment Variables).`,
    });
  }

  const workflowFile = process.env.GITHUB_WORKFLOW_FILE || "fetch-data.yml";
  // Ưu tiên VERCEL_GIT_COMMIT_REF - biến Vercel TỰ ĐỘNG cấp cho mọi deploy,
  // đúng bằng tên nhánh của chính bản deploy đang chạy (production lẫn
  // preview). Nhờ vậy bấm "Fetch dữ liệu" trên 1 preview deploy (nhánh
  // review) sẽ dispatch workflow đúng trên nhánh đó, không bị lệch sang
  // main như khi dùng GITHUB_REF cố định. GITHUB_REF chỉ còn là fallback thủ
  // công (vd chạy ngoài Vercel, hoặc cố tình muốn preview cũng ghi vào main).
  const ref = process.env.VERCEL_GIT_COMMIT_REF || process.env.GITHUB_REF || "main";

  try {
    const ghRes = await fetch(
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
            force_refresh_comments: forceRefreshComments ? "true" : "false",
            full_channel_history: fullChannelHistory ? "true" : "false",
            full_history_channels: typeof fullHistoryChannels === "string" ? fullHistoryChannels : "",
            // Chỉ được set khi gọi nội bộ từ manage-channels.js sau khi thêm
            // kênh/tab mới - nút "Fetch dữ liệu" trên web không gửi 2 field
            // này nên mặc định vẫn là fetch toàn bộ như trước.
            only_channels: typeof onlyChannels === "string" ? onlyChannels : "",
            only_list: typeof onlyList === "string" ? onlyList : "",
          },
        }),
      }
    );

    if (ghRes.status === 204) {
      return res.status(200).json({ ok: true });
    }

    const errText = await ghRes.text();
    return res.status(502).json({
      error: `GitHub API từ chối yêu cầu (HTTP ${ghRes.status}). Kiểm tra GITHUB_TOKEN còn quyền không. Chi tiết: ${errText.slice(0, 300)}`,
    });
  } catch (err) {
    return res.status(500).json({ error: `Lỗi khi gọi GitHub API: ${err.message}` });
  }
}

function safeJsonParse(str) {
  try {
    return JSON.parse(str);
  } catch {
    return {};
  }
}
