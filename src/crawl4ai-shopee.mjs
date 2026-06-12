import { spawn } from 'node:child_process';
import path from 'node:path';
import { projectRoot } from './lib-records.mjs';

const scriptPath = path.join(projectRoot, 'scripts', 'crawl4ai-shopee.py');

export async function scrapeViaCrawl4AI(productUrl, {
  python = process.env.HERMES_CRAWL4AI_PYTHON || 'python3',
  timeoutMs = Number(process.env.HERMES_CRAWL4AI_TIMEOUT_MS || 90000),
} = {}) {
  return new Promise((resolve, reject) => {
    const child = spawn(python, [scriptPath, productUrl], {
      cwd: projectRoot,
      env: process.env,
      stdio: ['ignore', 'pipe', 'pipe'],
    });

    let stdout = '';
    let stderr = '';
    const timer = setTimeout(() => {
      child.kill('SIGTERM');
      reject(new Error(`Crawl4AI timeout after ${timeoutMs}ms`));
    }, timeoutMs);

    child.stdout.setEncoding('utf8');
    child.stderr.setEncoding('utf8');
    child.stdout.on('data', (chunk) => { stdout += chunk; });
    child.stderr.on('data', (chunk) => { stderr += chunk; });
    child.on('error', (error) => {
      clearTimeout(timer);
      reject(error);
    });
    child.on('close', (code) => {
      clearTimeout(timer);
      if (code !== 0) {
        reject(new Error(stderr.trim() || `Crawl4AI exited with code ${code}`));
        return;
      }

      try {
        resolve(JSON.parse(stdout));
      } catch (error) {
        reject(new Error(`Crawl4AI returned invalid JSON: ${error.message}; stdout=${stdout.slice(0, 500)}`));
      }
    });
  });
}
