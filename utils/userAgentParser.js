import { UAParser } from 'ua-parser-js';

const KNOWN_BOT_REGEX = /googlebot|bingbot|yandexbot|duckduckbot|slurp|baiduspider|facebookexternalhit|twitterbot|rogerbot|linkedinbot|embedly|quora link preview|showyoubot|outbrain|pinterest\/0\.|pinterestbot|applebot|crawler|spider|robot|crawling|headlesschrome|phantomjs/i;

export function parseUserAgent(userAgentString) {
  const ua = String(userAgentString || '').trim();

  if (!ua) {
    return {
      isBot: false,
      device: 'Unknown',
      browser: 'Unknown',
      os: 'Unknown',
    };
  }

  // Detect bots and crawlers
  const isBot = KNOWN_BOT_REGEX.test(ua);

  const parser = new UAParser(ua);
  const result = parser.getResult();

  // Parse Browser
  const browserName = result.browser.name || 'Unknown Browser';
  const browserMajor = result.browser.major || (result.browser.version ? result.browser.version.split('.')[0] : '');
  const browser = browserMajor ? `${browserName} ${browserMajor}` : browserName;

  // Parse OS
  const osName = result.os.name || 'Unknown OS';
  const osVersion = result.os.version ? ` ${result.os.version.split('.')[0]}` : '';
  const os = `${osName}${osVersion}`;

  // Parse Device Type
  let rawDeviceType = result.device.type; // mobile, tablet, console, smarttv, wearable, embedded
  let deviceType = 'Desktop';
  if (rawDeviceType === 'mobile') {
    deviceType = 'Mobile';
  } else if (rawDeviceType === 'tablet') {
    deviceType = 'Tablet';
  } else if (result.os.name === 'Android' || result.os.name === 'iOS') {
    deviceType = 'Mobile';
  }

  // Combine device and OS: e.g. "Mobile (Android)" or "Desktop (Windows)"
  const device = `${deviceType} (${osName})`;

  return {
    isBot,
    device,
    browser,
    os,
  };
}
