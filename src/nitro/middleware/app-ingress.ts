import { defineHandler } from 'nitro/h3';
import { handleAppIngress } from '~server/apps/app-ingress';
export default defineHandler((event) => handleAppIngress(event.req));
