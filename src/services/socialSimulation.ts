import { SocialPost } from '../types';

const USERNAMES = ['CryptoKing', 'MemeLord', 'DogeFather', 'SatoshiNakamoto', 'VitalikButerin', 'ElonMusk', 'DiamondHands', 'RocketMan'];
const CONTENT_TEMPLATES = [
  "Just bought more ${coin}! To the moon! 🚀",
  "Is ${coin} the next 100x? Chart looking spicy 🌶️",
  "Don't sleep on ${coin}. Community is strong.",
  "Selling my house to buy ${coin}. NFA.",
  "Why is ${coin} dumping? panic selling!",
  "${coin} is a scam, beware.",
  "LFG ${coin}!!!",
  "Just found this gem: ${coin}",
];

export class SocialSimulationService {
  static generateRandomPost(coinSymbol: string, existingUsers: Map<string, number>): SocialPost {
    const userId = Math.floor(Math.random() * 1000).toString();
    const username = USERNAMES[Math.floor(Math.random() * USERNAMES.length)] + userId;

    const currentCount = existingUsers.get(userId) || 0;
    const newCount = currentCount + 1;
    existingUsers.set(userId, newCount);

    const isInfluencer = Math.random() > 0.95;
    const followerCount = isInfluencer
      ? Math.floor(Math.random() * 500000) + 10000
      : Math.floor(Math.random() * 2000) + 10;

    const engagementCount = isInfluencer
      ? Math.floor(Math.random() * 5000) + 100
      : Math.floor(Math.random() * 50);

    const template = CONTENT_TEMPLATES[Math.floor(Math.random() * CONTENT_TEMPLATES.length)];
    const content = template.replace('${coin}', coinSymbol);

    return {
      post_id: Math.random().toString(36).substring(7),
      timestamp: Date.now(),
      user_id: userId,
      username,
      platform: Math.random() > 0.3 ? 'X' : 'YouTube',
      follower_count: followerCount,
      engagement_count: engagementCount,
      user_post_index: newCount,
      content,
    };
  }
}
