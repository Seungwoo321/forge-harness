import { prepareSessionReturn } from './continuity-return.mjs';
export const stopGoalSession = input => prepareSessionReturn({...input,mode:'stopped'});
