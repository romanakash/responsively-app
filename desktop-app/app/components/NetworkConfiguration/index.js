import React from 'react';
import cx from 'classnames';
import ClearNetworkCache from '../ClearNetworkCache';
import NetworkThrottling from '../NetworkThrottling';

import styles from './styles.css';
import commonStyles from '../common.styles.css';

export default function DeviceDrawer({
  throttling,
  onActiveThrottlingProfileChanged,
  onThrottlingProfilesListChanged,
  onClearNetworkCache,
}) {
  return (
    <div>
      <ClearNetworkCache onClearNetworkCache={onClearNetworkCache} />
      <NetworkThrottling
        throttling={throttling}
        onActiveThrottlingProfileChanged={onActiveThrottlingProfileChanged}
        onThrottlingProfilesListChanged={onThrottlingProfilesListChanged}
      />
    </div>
  );
}
