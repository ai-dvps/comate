import { defineCollection } from 'astro:content';
import { glob } from 'astro/loaders';
import { z } from 'astro/zod';

const home = defineCollection({
  loader: glob({ pattern: '**/*.mdx', base: './src/content/home' }),
  schema: z.object({
    title: z.string(),
    description: z.string(),
    headline: z.string().optional(),
    subheadline: z.string().optional(),
    ctaText: z.string(),
    ctaHref: z.string(),
    secondaryCtaText: z.string().optional(),
    secondaryCtaHref: z.string().optional(),
    stats: z
      .array(
        z.object({
          label: z.string(),
          value: z.string(),
          icon: z.string().optional(),
        })
      )
      .optional(),
  }),
});

const features = defineCollection({
  loader: glob({ pattern: '**/*.mdx', base: './src/content/features' }),
  schema: z.object({
    title: z.string(),
    description: z.string(),
    category: z.string(),
    icon: z.string().optional(),
    image: z.string().optional(),
    imageAlt: z.string().optional(),
    order: z.number().default(0),
    gradientFrom: z.string().optional(),
    gradientTo: z.string().optional(),
  }),
});

const usage = defineCollection({
  loader: glob({ pattern: '**/*.mdx', base: './src/content/usage' }),
  schema: z.object({
    title: z.string(),
    step: z.number(),
  }),
});

const faq = defineCollection({
  loader: glob({ pattern: '**/*.mdx', base: './src/content/faq' }),
  schema: z.object({
    question: z.string(),
    order: z.number().default(0),
  }),
});

export const collections = { home, features, usage, faq };
