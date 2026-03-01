import { SocialPost, HypeMetrics } from '../types';

export class HypeCalculator {
  // Step 2: The Per-Post 'Base Value' Calculation
  static calculateBaseValue(post: SocialPost): number {
    // Calculate the Follower_Score: Divide the follower_count by 1000.
    const followerScore = post.follower_count / 1000;

    // Calculate the Engagement_Score: Multiply the engagement_count by 2 (alpha weight).
    const engagementScore = post.engagement_count * 2;

    // Calculate the Raw_Impact: Add the Follower_Score and the Engagement_Score together.
    const rawImpact = followerScore + engagementScore;

    // Calculate the Spam_Penalty: Take the square root of the user_post_index.
    // Ensure user_post_index is at least 1 to avoid division by zero or imaginary numbers
    const spamPenalty = Math.sqrt(Math.max(1, post.user_post_index));

    // Finalize the Base_Value: Divide the Raw_Impact by the Spam_Penalty.
    return rawImpact / spamPenalty;
  }

  // Step 3: The Hyperbolic Time Decay Calculation
  static calculateDecayFactor(postTimestamp: number, currentTimestamp: number): number {
    // Calculate Hours_Elapsed
    const msElapsed = currentTimestamp - postTimestamp;
    const hoursElapsed = Math.max(0, msElapsed / (1000 * 60 * 60));

    // Calculate the Decay_Factor: 1 / (1 + (0.2 * Hours_Elapsed))
    return 1 / (1 + 0.2 * hoursElapsed);
  }

  static calculatePostMetrics(post: SocialPost, currentTimestamp: number): HypeMetrics {
    const base_value = this.calculateBaseValue(post);
    const decay_factor = this.calculateDecayFactor(post.timestamp, currentTimestamp);
    const current_value = base_value * decay_factor;

    return {
      base_value,
      decay_factor,
      current_value,
    };
  }

  // Step 4: The Aggregation (TrueHype Score)
  static calculateTrueHypeScore(posts: SocialPost[], currentTimestamp: number): { score: number; validPosts: (SocialPost & HypeMetrics)[] } {
    let totalScore = 0;
    const validPosts: (SocialPost & HypeMetrics)[] = [];

    for (const post of posts) {
      const metrics = this.calculatePostMetrics(post, currentTimestamp);

      // Constraint: Drop posts older than 72 hours
      const msElapsed = currentTimestamp - post.timestamp;
      const hoursElapsed = msElapsed / (1000 * 60 * 60);
      
      if (hoursElapsed > 72) {
        continue;
      }

      // Constraint: Drop posts where Current_Post_Value falls below 0.01
      if (metrics.current_value < 0.01) {
        continue;
      }

      totalScore += metrics.current_value;
      validPosts.push({ ...post, ...metrics });
    }

    return { score: totalScore, validPosts };
  }
}
