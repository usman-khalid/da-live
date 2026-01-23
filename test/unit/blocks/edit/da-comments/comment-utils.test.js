import { expect } from '@esm-bundle/chai';
import {
  createReply,
  resolveComment,
  unresolveComment,
  groupCommentsByThread,
  getRootComment,
  formatTimestamp,
  getInitials,
  addReaction,
  removeReaction,
  hasUserReacted,
  getReactionsList,
  REACTION_EMOJIS,
} from '../../../../../blocks/edit/da-comments/helpers/comment-utils.js';

describe('comment-utils', () => {
  describe('createReply', () => {
    it('creates a reply with correct structure', () => {
      const parentComment = {
        id: 'parent-123',
        threadId: 'thread-456',
      };
      const author = {
        id: 'user-789',
        name: 'John Doe',
        email: 'john@example.com',
      };

      const reply = createReply(parentComment, author, 'Test reply content');

      expect(reply.threadId).to.equal('thread-456');
      expect(reply.parentId).to.equal('parent-123');
      expect(reply.author.id).to.equal('user-789');
      expect(reply.author.name).to.equal('John Doe');
      expect(reply.author.email).to.equal('john@example.com');
      expect(reply.content).to.equal('Test reply content');
      expect(reply.resolved).to.be.false;
      expect(reply.resolvedBy).to.be.null;
      expect(reply.resolvedAt).to.be.null;
      expect(reply.id).to.be.a('string');
      expect(reply.createdAt).to.be.a('number');
      expect(reply.updatedAt).to.be.a('number');
    });

    it('handles author without email', () => {
      const parentComment = { id: 'parent-123', threadId: 'thread-456' };
      const author = { id: 'user-789', name: 'John Doe' };

      const reply = createReply(parentComment, author, 'Content');

      expect(reply.author.email).to.equal('');
    });
  });

  describe('resolveComment', () => {
    it('marks a comment as resolved', () => {
      const comment = {
        id: 'comment-123',
        threadId: 'thread-456',
        content: 'Original comment',
        resolved: false,
      };
      const resolver = { id: 'resolver-789', name: 'Jane Smith' };

      const resolved = resolveComment(comment, resolver);

      expect(resolved.resolved).to.be.true;
      expect(resolved.resolvedBy.id).to.equal('resolver-789');
      expect(resolved.resolvedBy.name).to.equal('Jane Smith');
      expect(resolved.resolvedAt).to.be.a('number');
      expect(resolved.content).to.equal('Original comment');
    });

    it('preserves original comment properties', () => {
      const comment = {
        id: 'comment-123',
        threadId: 'thread-456',
        author: { id: 'author-1', name: 'Author' },
        content: 'Test',
        reactions: { '👍': [{ userId: 'u1' }] },
      };
      const resolver = { id: 'r1', name: 'Resolver' };

      const resolved = resolveComment(comment, resolver);

      expect(resolved.id).to.equal('comment-123');
      expect(resolved.threadId).to.equal('thread-456');
      expect(resolved.reactions).to.deep.equal({ '👍': [{ userId: 'u1' }] });
    });
  });

  describe('unresolveComment', () => {
    it('clears resolved status from a comment', () => {
      const comment = {
        id: 'comment-123',
        threadId: 'thread-456',
        content: 'Test comment',
        resolved: true,
        resolvedBy: { id: 'resolver-789', name: 'Jane Smith' },
        resolvedAt: 1234567890,
      };

      const unresolved = unresolveComment(comment);

      expect(unresolved.resolved).to.be.false;
      expect(unresolved.resolvedBy).to.be.null;
      expect(unresolved.resolvedAt).to.be.null;
      expect(unresolved.content).to.equal('Test comment');
    });

    it('preserves original comment properties', () => {
      const comment = {
        id: 'comment-123',
        threadId: 'thread-456',
        author: { id: 'author-1', name: 'Author' },
        content: 'Test',
        reactions: { '👍': [{ userId: 'u1' }] },
        resolved: true,
        resolvedBy: { id: 'r1', name: 'Resolver' },
        resolvedAt: 1234567890,
      };

      const unresolved = unresolveComment(comment);

      expect(unresolved.id).to.equal('comment-123');
      expect(unresolved.threadId).to.equal('thread-456');
      expect(unresolved.author).to.deep.equal({ id: 'author-1', name: 'Author' });
      expect(unresolved.reactions).to.deep.equal({ '👍': [{ userId: 'u1' }] });
    });

    it('works on already unresolved comment', () => {
      const comment = {
        id: 'comment-123',
        resolved: false,
        resolvedBy: null,
        resolvedAt: null,
      };

      const unresolved = unresolveComment(comment);

      expect(unresolved.resolved).to.be.false;
      expect(unresolved.resolvedBy).to.be.null;
      expect(unresolved.resolvedAt).to.be.null;
    });
  });

  describe('groupCommentsByThread', () => {
    it('groups comments by threadId using Map', () => {
      const commentsMap = new Map();
      commentsMap.set('c1', { threadId: 'thread-1', parentId: null, createdAt: 1000 });
      commentsMap.set('c2', { threadId: 'thread-1', parentId: 'c1', createdAt: 2000 });
      commentsMap.set('c3', { threadId: 'thread-2', parentId: null, createdAt: 3000 });

      const threads = groupCommentsByThread(commentsMap);

      expect(threads.size).to.equal(2);
      expect(threads.get('thread-1').length).to.equal(2);
      expect(threads.get('thread-2').length).to.equal(1);
    });

    it('sorts comments by createdAt within each thread', () => {
      const commentsMap = new Map();
      commentsMap.set('c1', { threadId: 'thread-1', createdAt: 3000 });
      commentsMap.set('c2', { threadId: 'thread-1', createdAt: 1000 });
      commentsMap.set('c3', { threadId: 'thread-1', createdAt: 2000 });

      const threads = groupCommentsByThread(commentsMap);
      const thread1 = threads.get('thread-1');

      expect(thread1[0].createdAt).to.equal(1000);
      expect(thread1[1].createdAt).to.equal(2000);
      expect(thread1[2].createdAt).to.equal(3000);
    });

    it('handles null or invalid comments', () => {
      const commentsMap = new Map();
      commentsMap.set('c1', null);
      commentsMap.set('c2', { noThreadId: true });
      commentsMap.set('c3', { threadId: 'valid', createdAt: 1000 });

      const threads = groupCommentsByThread(commentsMap);

      expect(threads.size).to.equal(1);
      expect(threads.get('valid').length).to.equal(1);
    });
  });

  describe('getRootComment', () => {
    it('returns the comment with null parentId', () => {
      const comments = [
        { id: 'c1', parentId: 'c0', content: 'Reply' },
        { id: 'c0', parentId: null, content: 'Root' },
      ];

      const root = getRootComment(comments);

      expect(root.id).to.equal('c0');
      expect(root.content).to.equal('Root');
    });

    it('returns first comment if no root found', () => {
      const comments = [
        { id: 'c1', parentId: 'c0', content: 'Reply 1' },
        { id: 'c2', parentId: 'c0', content: 'Reply 2' },
      ];

      const root = getRootComment(comments);

      expect(root.id).to.equal('c1');
    });
  });

  describe('formatTimestamp', () => {
    it('returns "Just now" for recent timestamps', () => {
      const now = Date.now();
      expect(formatTimestamp(now)).to.equal('Just now');
      expect(formatTimestamp(now - 30000)).to.equal('Just now'); // 30 seconds ago
    });

    it('returns minutes ago for timestamps within an hour', () => {
      const fiveMinutesAgo = Date.now() - (5 * 60 * 1000);
      expect(formatTimestamp(fiveMinutesAgo)).to.equal('5m ago');
    });

    it('returns hours ago for timestamps within a day', () => {
      const threeHoursAgo = Date.now() - (3 * 60 * 60 * 1000);
      expect(formatTimestamp(threeHoursAgo)).to.equal('3h ago');
    });

    it('returns days ago for timestamps within a week', () => {
      const twoDaysAgo = Date.now() - (2 * 24 * 60 * 60 * 1000);
      expect(formatTimestamp(twoDaysAgo)).to.equal('2d ago');
    });

    it('returns formatted date for older timestamps', () => {
      const twoWeeksAgo = Date.now() - (14 * 24 * 60 * 60 * 1000);
      const result = formatTimestamp(twoWeeksAgo);
      // Should contain month abbreviation and day
      expect(result).to.match(/\w+ \d+/);
    });
  });

  describe('getInitials', () => {
    it('returns initials from two-word name', () => {
      expect(getInitials('John Doe')).to.equal('JD');
    });

    it('returns first two chars from single-word name', () => {
      expect(getInitials('John')).to.equal('JO');
    });

    it('returns initials from multi-word name', () => {
      expect(getInitials('John Robert Doe')).to.equal('JD');
    });

    it('returns ? for empty or null name', () => {
      expect(getInitials('')).to.equal('?');
      expect(getInitials(null)).to.equal('?');
      expect(getInitials(undefined)).to.equal('?');
    });

    it('handles names with extra spaces', () => {
      expect(getInitials('  John   Doe  ')).to.equal('JD');
    });
  });

  describe('REACTION_EMOJIS', () => {
    it('contains expected emojis', () => {
      expect(REACTION_EMOJIS).to.be.an('array');
      expect(REACTION_EMOJIS.length).to.be.greaterThan(0);
      expect(REACTION_EMOJIS).to.include('👍');
    });
  });

  describe('addReaction', () => {
    it('adds a new reaction to a comment', () => {
      const comment = { id: 'c1', reactions: {} };
      const user = { id: 'u1', name: 'John' };

      const updated = addReaction(comment, '👍', user);

      expect(updated.reactions['👍']).to.have.length(1);
      expect(updated.reactions['👍'][0].userId).to.equal('u1');
      expect(updated.reactions['👍'][0].name).to.equal('John');
    });

    it('adds reaction to new emoji', () => {
      const comment = {
        id: 'c1',
        reactions: { '👍': [{ userId: 'u1', name: 'John' }] },
      };
      const user = { id: 'u2', name: 'Jane' };

      const updated = addReaction(comment, '❤️', user);

      expect(updated.reactions['👍']).to.have.length(1);
      expect(updated.reactions['❤️']).to.have.length(1);
    });

    it('does not duplicate reaction from same user', () => {
      const comment = {
        id: 'c1',
        reactions: { '👍': [{ userId: 'u1', name: 'John' }] },
      };
      const user = { id: 'u1', name: 'John' };

      const updated = addReaction(comment, '👍', user);

      expect(updated.reactions['👍']).to.have.length(1);
    });

    it('handles comment without reactions property', () => {
      const comment = { id: 'c1' };
      const user = { id: 'u1', name: 'John' };

      const updated = addReaction(comment, '👍', user);

      expect(updated.reactions['👍']).to.have.length(1);
    });
  });

  describe('removeReaction', () => {
    it('removes a reaction from a comment', () => {
      const comment = {
        id: 'c1',
        reactions: { '👍': [{ userId: 'u1', name: 'John' }, { userId: 'u2', name: 'Jane' }] },
      };

      const updated = removeReaction(comment, '👍', 'u1');

      expect(updated.reactions['👍']).to.have.length(1);
      expect(updated.reactions['👍'][0].userId).to.equal('u2');
    });

    it('removes emoji key when last reaction is removed', () => {
      const comment = {
        id: 'c1',
        reactions: { '👍': [{ userId: 'u1', name: 'John' }] },
      };

      const updated = removeReaction(comment, '👍', 'u1');

      expect(updated.reactions['👍']).to.be.undefined;
    });

    it('handles removing non-existent reaction gracefully', () => {
      const comment = {
        id: 'c1',
        reactions: { '👍': [{ userId: 'u1', name: 'John' }] },
      };

      const updated = removeReaction(comment, '❤️', 'u1');

      expect(updated.reactions['👍']).to.have.length(1);
    });
  });

  describe('hasUserReacted', () => {
    it('returns true when user has reacted', () => {
      const comment = { reactions: { '👍': [{ userId: 'u1', name: 'John' }] } };

      expect(hasUserReacted(comment, '👍', 'u1')).to.be.true;
    });

    it('returns false when user has not reacted', () => {
      const comment = { reactions: { '👍': [{ userId: 'u1', name: 'John' }] } };

      expect(hasUserReacted(comment, '👍', 'u2')).to.be.false;
    });

    it('returns false for non-existent emoji', () => {
      const comment = { reactions: { '👍': [{ userId: 'u1', name: 'John' }] } };

      expect(hasUserReacted(comment, '❤️', 'u1')).to.be.false;
    });

    it('handles comment without reactions', () => {
      const comment = { id: 'c1' };

      expect(hasUserReacted(comment, '👍', 'u1')).to.be.false;
    });
  });

  describe('getReactionsList', () => {
    it('returns array of reactions with counts', () => {
      const comment = {
        reactions: {
          '👍': [{ userId: 'u1', name: 'John' }, { userId: 'u2', name: 'Jane' }],
          '❤️': [{ userId: 'u1', name: 'John' }],
        },
      };

      const list = getReactionsList(comment);

      expect(list).to.have.length(2);

      const thumbs = list.find((r) => r.emoji === '👍');
      expect(thumbs.count).to.equal(2);
      expect(thumbs.users).to.have.length(2);

      const heart = list.find((r) => r.emoji === '❤️');
      expect(heart.count).to.equal(1);
    });

    it('filters out empty reaction arrays', () => {
      const comment = {
        reactions: {
          '👍': [{ userId: 'u1', name: 'John' }],
          '❤️': [],
        },
      };

      const list = getReactionsList(comment);

      expect(list).to.have.length(1);
      expect(list[0].emoji).to.equal('👍');
    });

    it('returns empty array for comment without reactions', () => {
      const comment = { id: 'c1' };

      expect(getReactionsList(comment)).to.deep.equal([]);
    });
  });
});
