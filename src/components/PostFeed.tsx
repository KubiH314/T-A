import React from 'react';
import { SocialPost, HypeMetrics } from '../types';
import { formatDistanceToNow } from 'date-fns';
import { MessageCircle, Heart, Repeat, User } from 'lucide-react';

interface PostFeedProps {
  posts: (SocialPost & HypeMetrics)[];
}

export function PostFeed({ posts }: PostFeedProps) {
  // Sort by timestamp descending
  const sortedPosts = [...posts].sort((a, b) => b.timestamp - a.timestamp);

  return (
    <div className="space-y-4">
      {sortedPosts.length === 0 && (
        <div className="text-center py-8 text-neutral-500">
          No active posts detected yet.
        </div>
      )}
      {sortedPosts.map((post) => (
        <div 
          key={post.post_id} 
          className="bg-white border border-neutral-200 rounded-xl p-4 transition-all hover:bg-neutral-50 hover:border-neutral-300"
        >
          <div className="flex justify-between items-start mb-2">
            <div className="flex items-center gap-2">
              <div className="w-8 h-8 rounded-full bg-neutral-100 flex items-center justify-center">
                <User className="w-4 h-4 text-neutral-500" />
              </div>
              <div>
                <div className="flex items-center gap-2">
                  <span className="font-medium text-sm text-neutral-900">@{post.username}</span>
                  <span className="text-xs text-neutral-500 bg-neutral-100 px-1.5 py-0.5 rounded">
                    {post.platform}
                  </span>
                </div>
                <div className="text-xs text-neutral-400">
                  {formatDistanceToNow(post.timestamp, { addSuffix: true })} • Post #{post.user_post_index}
                </div>
              </div>
            </div>
            <div className="text-right">
              <div className="text-indigo-600 font-bold text-lg">
                {post.current_value.toFixed(2)}
              </div>
              <div className="text-[10px] text-neutral-400 uppercase tracking-wider">
                Impact Score
              </div>
            </div>
          </div>

          <p className="text-sm text-neutral-700 mb-3 leading-relaxed">
            {post.content}
          </p>

          <div className="flex items-center justify-between pt-3 border-t border-neutral-100">
            <div className="flex gap-4 text-xs text-neutral-500">
              <span className="flex items-center gap-1">
                <User className="w-3 h-3" /> {post.follower_count.toLocaleString()} followers
              </span>
              <span className="flex items-center gap-1">
                <Heart className="w-3 h-3" /> {post.engagement_count.toLocaleString()} eng.
              </span>
            </div>
            <div className="flex gap-2 text-[10px] font-mono text-neutral-400">
              <span>Base: {post.base_value.toFixed(2)}</span>
              <span>•</span>
              <span>Decay: {post.decay_factor.toFixed(2)}x</span>
            </div>
          </div>
        </div>
      ))}
    </div>
  );
}
