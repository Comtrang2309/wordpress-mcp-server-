import express from "express";
import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { SSEServerTransport } from "@modelcontextprotocol/sdk/server/sse.js";
import {
  CallToolRequestSchema,
  ListToolsRequestSchema,
} from "@modelcontextprotocol/sdk/types.js";
import axios from "axios";
import dotenv from "dotenv";

dotenv.config();

// ════════════════════════════════════════
//   WORDPRESS CLIENT
// ════════════════════════════════════════
const wpClient = axios.create({
  baseURL: `${process.env.WP_BASE_URL}/wp-json/wp/v2`,
  auth: {
    username: process.env.WP_USERNAME,
    password: process.env.WP_APP_PASSWORD,
  },
  headers: { "Content-Type": "application/json" },
});

// ════════════════════════════════════════
//   MCP SERVER
// ════════════════════════════════════════
const mcpServer = new Server(
  { name: "wordpress-mcp", version: "1.0.0" },
  { capabilities: { tools: {} } }
);

// ════════════════════════════════════════
//   ĐỊNH NGHĨA TOOLS
// ════════════════════════════════════════
mcpServer.setRequestHandler(ListToolsRequestSchema, async () => ({
  tools: [
    {
      name: "wp_get_posts",
      description: "Lấy danh sách bài viết từ WordPress",
      inputSchema: {
        type: "object",
        properties: {
          per_page: { type: "number", description: "Số bài mỗi trang" },
          page:     { type: "number", description: "Số trang" },
          search:   { type: "string", description: "Từ khóa tìm kiếm" },
          status:   { type: "string", description: "publish | draft | private" },
        },
      },
    },
    {
      name: "wp_create_post",
      description: "Tạo bài viết mới trên WordPress",
      inputSchema: {
        type: "object",
        required: ["title", "content"],
        properties: {
          title:   { type: "string", description: "Tiêu đề bài viết" },
          content: { type: "string", description: "Nội dung HTML" },
          status:  { type: "string", description: "publish | draft" },
          excerpt: { type: "string", description: "Tóm tắt bài viết" },
        },
      },
    },
    {
      name: "wp_update_post",
      description: "Cập nhật bài viết đã có",
      inputSchema: {
        type: "object",
        required: ["post_id"],
        properties: {
          post_id: { type: "number", description: "ID bài viết" },
          title:   { type: "string", description: "Tiêu đề mới" },
          content: { type: "string", description: "Nội dung mới" },
          status:  { type: "string", description: "Trạng thái mới" },
        },
      },
    },
    {
      name: "wp_delete_post",
      description: "Xóa bài viết",
      inputSchema: {
        type: "object",
        required: ["post_id"],
        properties: {
          post_id: { type: "number", description: "ID bài viết cần xóa" },
          force:   { type: "boolean", description: "true = xóa vĩnh viễn" },
        },
      },
    },
    {
      name: "wp_get_site_info",
      description: "Lấy thông tin tổng quan website WordPress",
      inputSchema: { type: "object", properties: {} },
    },
  ],
}));

// ════════════════════════════════════════
//   XỬ LÝ KHI AGENT GỌI TOOL
// ════════════════════════════════════════
mcpServer.setRequestHandler(CallToolRequestSchema, async (request) => {
  const { name, arguments: args } = request.params;

  try {
    switch (name) {

      case "wp_get_posts": {
        const res = await wpClient.get("/posts", { params: args });
        return {
          content: [{
            type: "text",
            text: JSON.stringify({
              total:     res.headers["x-wp-total"],
              totalPage: res.headers["x-wp-totalpages"],
              posts: res.data.map(p => ({
                id:      p.id,
                title:   p.title.rendered,
                status:  p.status,
                date:    p.date,
                link:    p.link,
                excerpt: p.excerpt.rendered,
              })),
            }, null, 2),
          }],
        };
      }

      case "wp_create_post": {
        const res = await wpClient.post("/posts", {
          title:   args.title,
          content: args.content,
          status:  args.status  || "draft",
          excerpt: args.excerpt || "",
        });
        return {
          content: [{
            type: "text",
            text: JSON.stringify({
              success: true,
              post_id: res.data.id,
              link:    res.data.link,
              status:  res.data.status,
            }, null, 2),
          }],
        };
      }

      case "wp_update_post": {
        const { post_id, ...data } = args;
        const res = await wpClient.put(`/posts/${post_id}`, data);
        return {
          content: [{
            type: "text",
            text: JSON.stringify({
              success:  true,
              post_id:  res.data.id,
              modified: res.data.modified,
            }, null, 2),
          }],
        };
      }

      case "wp_delete_post": {
        await wpClient.delete(`/posts/${args.post_id}`, {
          params: { force: args.force || false },
        });
        return {
          content: [{
            type: "text",
            text: JSON.stringify({
              success:    true,
              deleted_id: args.post_id,
            }, null, 2),
          }],
        };
      }

      case "wp_get_site_info": {
        const res = await axios.get(`${process.env.WP_BASE_URL}/wp-json`);
        return {
          content: [{
            type: "text",
            text: JSON.stringify({
              name:        res.data.name,
              description: res.data.description,
              url:         res.data.url,
            }, null, 2),
          }],
        };
      }

      default:
        throw new Error(`Không tìm thấy tool: ${name}`);
    }

  } catch (err) {
    return {
      content: [{
        type: "text",
        text: `❌ Lỗi: ${err.response?.data?.message || err.message}`,
      }],
      isError: true,
    };
  }
});

// ════════════════════════════════════════
//   EXPRESS HTTP SERVER
// ════════════════════════════════════════
const app = express();
app.use(express.json());

// Lưu các SSE session
const transports = {};

// ── Health Check ──
app.get("/", (req, res) => {
  res.json({
    status:   "✅ running",
    service:  "WordPress MCP Server",
    endpoint: "/sse",
    time:     new Date().toISOString(),
  });
});

// ── SSE Endpoint (Abacus AI kết nối vào đây) ──
app.get("/sse", async (req, res) => {
  console.log("📡 Abacus AI đã kết nối...");

  res.setHeader("Content-Type",                "text/event-stream");
  res.setHeader("Cache-Control",               "no-cache");
  res.setHeader("Connection",                  "keep-alive");
  res.setHeader("Access-Control-Allow-Origin", "*");

  const transport = new SSEServerTransport("/messages", res);
  transports[transport.sessionId] = transport;

  res.on("close", () => {
    console.log("🔌 Client ngắt kết nối:", transport.sessionId);
    delete transports[transport.sessionId];
  });

  await mcpServer.connect(transport);
});

// ── Messages Endpoint ──
app.post("/messages", async (req, res) => {
  const sessionId  = req.query.sessionId;
  const transport  = transports[sessionId];

  if (!transport) {
    return res.status(404).json({ error: "Session không tồn tại" });
  }

  await transport.handlePostMessage(req, res, req.body);
});

// ── Khởi động ──
const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
  console.log(`🚀 Server chạy tại port: ${PORT}`);
  console.log(`📡 SSE URL: http://localhost:${PORT}/sse`);
});
