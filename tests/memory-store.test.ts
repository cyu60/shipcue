import { memoryStore } from '../src/server';
import { storeContract } from './store.contract';

storeContract('memory', async () => memoryStore());
