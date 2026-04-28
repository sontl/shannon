// Copyright (C) 2025 Keygraph, Inc.
//
// This program is free software: you can redistribute it and/or modify
// it under the terms of the GNU Affero General Public License version 3
// as published by the Free Software Foundation.

/**
 * Appium MCP Server
 *
 * Minimal MCP server that exposes Appium device interaction tools for
 * mobile pentest agents. Runs as a stdio subprocess alongside the main
 * Shannon helper MCP server.
 *
 * Tools:
 * - appium_tap: Tap an element by accessibility ID or XPath
 * - appium_type: Type text into an element
 * - appium_swipe: Swipe in a direction
 * - appium_screenshot: Capture device screenshot (base64)
 * - appium_hierarchy: Get UI element hierarchy (accessibility tree)
 * - appium_back: Press the back button
 * - appium_launch_app: Launch or restart the app
 *
 * Requires a running Appium server (default: http://localhost:4723).
 */

import { createSdkMcpServer } from '@anthropic-ai/claude-agent-sdk';
import { createAppiumTools } from './tools.js';

const appiumUrl = process.env.APPIUM_URL || 'http://localhost:4723';

const tools = createAppiumTools(appiumUrl);

const server = createSdkMcpServer({
  name: 'appium-mcp',
  version: '1.0.0',
  tools,
});

export { server };
export { createAppiumTools };
