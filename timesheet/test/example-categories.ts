import type { Category } from '../src/core/config.ts';

/** A made-up task list for tests and demo data; real lists are company specific. */
export const CATEGORIES: Category[] = [
  { name: 'Feature Build', subtask: 'New functionality', description: 'Features, screens, endpoints, jobs', capex: true, role: 'work' },
  { name: 'Connectors', subtask: 'Interfaces', description: 'API clients, webhooks, links to other systems', capex: true },
  { name: 'QA', subtask: 'Quality checks', description: 'Writing and running tests', capex: true },
  { name: 'Platform Build', subtask: 'New environments', description: 'Pipelines, clusters, cloud setups', capex: true },
  { name: 'Specs', subtask: 'Functional design', description: 'Workshops, specs, feature planning', capex: true, role: 'no-code' },
  { name: 'Release', subtask: 'Shipping', description: 'Publishing releases, approving deployments', capex: true, role: 'deploy' },
  { name: 'Firefighting', subtask: 'Production problems', description: 'Outages, crashes, hotfixes', capex: false, role: 'incident' },
  { name: 'Polish', subtask: 'Small changes', description: 'Tweaks and small fixes to existing features', capex: false },
  { name: 'Upkeep', subtask: 'Dependencies', description: 'Version bumps, patches, low-risk config', capex: false },
  { name: 'Platform Care', subtask: 'Running systems', description: 'Alerts, certificates, tuning', capex: false },
  { name: 'Discovery', subtask: 'Research', description: 'Investigation, reviews, notes without code', capex: false, role: 'no-code' },
  { name: 'Coordination', subtask: 'Planning people', description: 'Status updates, 1:1s', capex: false, role: 'no-code' },
  { name: 'Learning', subtask: 'Courses', description: 'Tutorials, talks, certifications', capex: false, role: 'no-code' },
  { name: 'Meetings', subtask: 'Team meetings', description: 'Standups, plannings, retros', capex: false, role: 'meeting' },
  { name: 'Other', subtask: 'Anything else', description: 'Work that fits nowhere else', capex: false, role: 'fallback' },
  { name: 'Legacy Support', subtask: 'Retired task', description: 'Available until the end of 2026', capex: false, classify: false, validTo: '2026-12-31' },
];
