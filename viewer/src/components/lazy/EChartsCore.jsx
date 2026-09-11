// Use the ESM adapter: the CommonJS core entry has a nested default in Rolldown.
import ReactEChartsCore from 'echarts-for-react/esm/core';
import { init, dispose, getInstanceByDom, use } from 'echarts/core';
import { LineChart } from 'echarts/charts';
import {
  GridComponent,
  TooltipComponent,
  LegendComponent,
  MarkAreaComponent,
  MarkLineComponent,
  MarkPointComponent,
} from 'echarts/components';
import { SVGRenderer } from 'echarts/renderers';

// Shared by the route timeline, ensemble plume, and model comparison.
// Keep registration behind EChartsLazy so planner startup stays chart-free.
use([
  LineChart,
  GridComponent,
  TooltipComponent,
  LegendComponent,
  MarkAreaComponent,
  MarkLineComponent,
  MarkPointComponent,
  SVGRenderer,
]);

// The React adapter only needs these lifecycle methods.
const echarts = { init, dispose, getInstanceByDom };

export default function EChartsCore(props) {
  return <ReactEChartsCore {...props} echarts={echarts} />;
}
