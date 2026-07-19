import { GraphQLClient, gql } from 'graphql-request';
import { env } from '../config/env';
import { getOrSetWithSWR, invalidateCacheByPrefix } from './cache.service';
import { logger } from '../utils/logger';
import { AppError } from '../middleware/errorHandler';

const client = new GraphQLClient(env.WPGRAPHQL_ENDPOINT, {
  // Fail fast rather than hanging a request thread on a slow/unresponsive CMS.
  fetch: (url: any, opts: any) =>
    fetch(url, { ...opts, signal: AbortSignal.timeout(5000) }),
});

/**
 * NOTE: These queries use WordPress's built-in `posts` type rather than a
 * custom `properties` post type, so this works out of the box against any
 * vanilla WordPress + WPGraphQL install (e.g. a quick TasteWP demo site)
 * without requiring a custom-post-type plugin to be configured first.
 *
 * In a real production deployment, you'd register a proper `properties`
 * custom post type (via Custom Post Type UI + Advanced Custom Fields, or
 * a bespoke plugin) with fields like price/bedrooms/bathrooms/address, and
 * swap the query below back to that type + those fields. The caching,
 * error-handling, and stale-while-revalidate logic around it does not
 * need to change either way.
 */
const GET_PROPERTIES_QUERY = gql`
  query GetProperties($first: Int!, $after: String) {
    posts(first: $first, after: $after, where: { status: PUBLISH }) {
      pageInfo {
        hasNextPage
        endCursor
      }
      nodes {
        id
        databaseId
        title
        slug
        date
        excerpt
        featuredImage {
          node {
            sourceUrl
          }
        }
      }
    }
  }
`;

const GET_PROPERTY_BY_SLUG_QUERY = gql`
  query GetPropertyBySlug($slug: ID!) {
    post(id: $slug, idType: SLUG) {
      id
      databaseId
      title
      slug
      content
      date
      modified
      featuredImage {
        node {
          sourceUrl
        }
      }
    }
  }
`;

interface WPProperty {
  id: string;
  databaseId: number;
  title: string;
  slug: string;
  date: string;
  excerpt?: string;
  content?: string;
  featuredImage?: { node?: { sourceUrl?: string } };
}

/**
 * Fetches a page of published property listings from the WordPress CMS.
 * Cached with stale-while-revalidate so that:
 *  - The CMS is only actually queried once per TTL window (default 5 min),
 *    not once per incoming API request - critical under high traffic,
 *    since WPGraphQL resolvers are typically much slower than a cache read.
 *  - If the CMS is temporarily down, we keep serving the last good page
 *    for `staleSeconds` instead of surfacing an error to end users.
 */
export async function fetchPublishedProperties(first = 20, after?: string) {
  const cacheKey = `wpcms:properties:${first}:${after ?? 'start'}`;

  return getOrSetWithSWR(cacheKey, env.WPGRAPHQL_CACHE_TTL_SECONDS, 600, async () => {
    try {
      const data = await client.request<{ posts: { pageInfo: any; nodes: WPProperty[] } }>(
        GET_PROPERTIES_QUERY,
        { first, after }
      );
      return data.posts;
    } catch (err: any) {
      logger.error('WPGraphQL fetchPublishedProperties failed', { error: err.message });
      throw new AppError('Unable to load property listings right now. Please try again shortly.', 502, 'CMS_UPSTREAM_ERROR');
    }
  });
}

export async function fetchPropertyBySlug(slug: string) {
  const cacheKey = `wpcms:property:${slug}`;

  return getOrSetWithSWR(cacheKey, env.WPGRAPHQL_CACHE_TTL_SECONDS, 600, async () => {
    try {
      const data = await client.request<{ post: WPProperty | null }>(GET_PROPERTY_BY_SLUG_QUERY, { slug });
      if (!data.post) {
        throw new AppError(`Property "${slug}" not found in CMS`, 404, 'NOT_FOUND');
      }
      return data.post;
    } catch (err: any) {
      if (err instanceof AppError) throw err;
      logger.error('WPGraphQL fetchPropertyBySlug failed', { slug, error: err.message });
      throw new AppError('Unable to load property details right now. Please try again shortly.', 502, 'CMS_UPSTREAM_ERROR');
    }
  });
}

/**
 * Called from the WordPress webhook (save_post / property updated hook, in a
 * real deployment) so an editor's change is visible well before the TTL
 * would naturally expire - "handles stale cache invalidation" from the
 * task spec, active-invalidation half of the strategy (SWR handles the
 * passive half).
 */
export async function invalidatePropertyCache(slug?: string) {
  if (slug) {
    await invalidateCacheByPrefix(`wpcms:property:${slug}`);
  }
  await invalidateCacheByPrefix('wpcms:properties:');
}
