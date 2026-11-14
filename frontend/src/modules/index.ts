import type { Section } from '../app/section'
import { admin } from './admin'
import { dashboard } from './dashboard'
import { finance } from './finance'
import { inventory } from './inventory'
import { marketing } from './marketing'
import { pos } from './pos'
import { production } from './production'
import { products } from './products'
import { purchasing } from './purchasing'
import { reports } from './reports'
import { sales } from './sales'
import { work } from './work'

/** Sidebar order. Each module file owns its pages, record routes and access rules. */
export const SECTIONS: Section[] = [dashboard, work, sales, pos, products, inventory, purchasing, production, finance, marketing, reports, admin]
