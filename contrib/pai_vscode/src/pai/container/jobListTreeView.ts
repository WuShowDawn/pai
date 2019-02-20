/**
 * Copyright (c) Microsoft Corporation. All rights reserved.
 * Licensed under the MIT License. See License in the project root for license information.
 * @author Microsoft
 */
/* tslint:disable:max-classes-per-file */

import { injectable } from 'inversify';
import * as request from 'request-promise-native';
import {
    commands, window, workspace, Event, EventEmitter, TreeDataProvider,
    TreeItem, TreeItemCollapsibleState, TreeView, WorkspaceConfiguration
} from 'vscode';

import {
    COMMAND_CONTAINER_JOBLIST_MORE, COMMAND_CONTAINER_JOBLIST_REFRESH,
    COMMAND_TREEVIEW_DOUBLECLICK, COMMAND_VIEW_JOB,
    CONTEXT_JOBLIST_CLUSTER,
    ICON_ELLIPSIS,
    ICON_ERROR,
    ICON_HISTORY,
    ICON_LATEST,
    ICON_LOADING,
    ICON_OK,
    ICON_PAI,
    ICON_QUEUE,
    ICON_RUN,
    ICON_STOP,
    SETTING_JOB_JOBLIST_ALLJOBSPAGESIZE,
    SETTING_JOB_JOBLIST_RECENTJOBSLENGTH,
    SETTING_JOB_JOBLIST_REFERSHINTERVAL,
    SETTING_SECTION_JOB,
    VIEW_CONTAINER_JOBLIST
} from '../../common/constants';
import { __ } from '../../common/i18n';
import { getSingleton, Singleton } from '../../common/singleton';
import { Util } from '../../common/util';
import { getClusterName, ClusterManager } from '../clusterManager';
import { IPAICluster, IPAIJobInfo } from '../paiInterface';
import { PAIRestUri } from '../paiUri';
import { RecentJobManager } from '../recentJobManager';

enum FilterType {
    Recent = 0,
    All = 1
}

enum LoadingState {
    Finished = 0,
    Loading = 1,
    Error = 2
}

enum TreeDataType {
    Cluster = 0,
    Filter = 1,
    Job = 2,
    More = 3
}

/**
 * Leaf node representing job on PAI
 */
export class JobNode extends TreeItem {
    private static statusIcons: { [status in IPAIJobInfo['state']]: string } = {
        SUCCEEDED: ICON_OK,
        FAILED: ICON_ERROR,
        WAITING: ICON_QUEUE,
        STOPPED: ICON_STOP,
        RUNNING: ICON_RUN
    };

    public constructor(jobInfo: IPAIJobInfo, config: IPAICluster) {
        super(jobInfo.name);
        this.command = {
            title: __('treeview.joblist.view'),
            command: COMMAND_TREEVIEW_DOUBLECLICK,
            arguments: [COMMAND_VIEW_JOB, jobInfo, config]
        };
        this.iconPath = Util.resolvePath(JobNode.statusIcons[jobInfo.state]);
    }
}

/**
 * Expand job list when chosen
 */
class ShowMoreNode extends TreeItem {
    public constructor(cluster: IClusterData) {
        super(__('treeview.joblist.more'));
        this.command = {
            title: __('treeview.joblist.more'),
            command: COMMAND_TREEVIEW_DOUBLECLICK,
            arguments: [COMMAND_CONTAINER_JOBLIST_MORE, cluster]
        };
        this.iconPath = Util.resolvePath(ICON_ELLIPSIS);
    }
}

/**
 * Secondary node containing filtered job list
 */
class FilterNode extends TreeItem {
    public constructor(type: FilterType, loadingState: LoadingState) {
        if (type === FilterType.Recent) {
            super(__('treeview.joblist.recent'), TreeItemCollapsibleState.Expanded);
        } else {
            super(__('treeview.joblist.all'), TreeItemCollapsibleState.Collapsed);
        }
        this.iconPath = Util.resolvePath(
            loadingState === LoadingState.Loading ? ICON_LOADING :
                loadingState === LoadingState.Error ? ICON_ERROR :
                    type === FilterType.Recent ? ICON_LATEST : ICON_HISTORY);
    }
}

/**
 * Root node representing PAI cluster
 */
export class ClusterNode extends TreeItem {
    public readonly index: number;
    public constructor(configuration: IPAICluster, index: number) {
        super(getClusterName(configuration), TreeItemCollapsibleState.Collapsed);
        this.index = index;
        this.iconPath = Util.resolvePath(ICON_PAI);
        this.contextValue = CONTEXT_JOBLIST_CLUSTER;
    }
}

interface IClusterData {
    type: TreeDataType.Cluster;
    config: IPAICluster;
    index: number;
    shownAmount: number;
    loadingState: LoadingState;
    jobs: IPAIJobInfo[];
    lastLatestJobName?: string;
    lastShownAmount?: number;
}

interface IFilterData {
    type: TreeDataType.Filter;
    filterType: FilterType;
    parent: IClusterData;
}

interface IJobData {
    type: TreeDataType.Job;
    job: IPAIJobInfo;
    parent: IFilterData;
}

interface IMoreData {
    type: TreeDataType.More;
    parent: IFilterData;
}

type ITreeData = IClusterData | IFilterData | IJobData | IMoreData;

/**
 * Contributes to the tree view of cluster job list
 */
@injectable()
export class JobListTreeDataProvider extends Singleton implements TreeDataProvider<ITreeData> {
    private onDidChangeTreeDataEmitter: EventEmitter<ITreeData> = new EventEmitter<ITreeData>();
    public onDidChangeTreeData: Event<ITreeData> = this.onDidChangeTreeDataEmitter.event; // tslint:disable-line

    private clusters: IClusterData[] = [];
    private readonly treeView: TreeView<ITreeData>;
    private refreshTimer: NodeJS.Timer | undefined;

    constructor() {
        super();
        this.treeView = window.createTreeView(VIEW_CONTAINER_JOBLIST, { treeDataProvider: this });
        this.context.subscriptions.push(
            commands.registerCommand(COMMAND_CONTAINER_JOBLIST_REFRESH, () => this.refresh()),
            commands.registerCommand(
                COMMAND_CONTAINER_JOBLIST_MORE,
                (cluster: IClusterData) => {
                    if (cluster.jobs.length <= cluster.shownAmount) {
                        return;
                    }
                    const settings: WorkspaceConfiguration = workspace.getConfiguration(SETTING_SECTION_JOB);
                    cluster.lastShownAmount = cluster.shownAmount;
                    cluster.shownAmount += settings.get<number>(SETTING_JOB_JOBLIST_ALLJOBSPAGESIZE)!;
                    void this.refresh(cluster.index, false);
                }
            )
        );
    }

    public async refresh(index: number = -1, reload: boolean = true): Promise<void> {
        if (index === -1 || !this.clusters[index]) {
            const settings: WorkspaceConfiguration = workspace.getConfiguration(SETTING_SECTION_JOB);
            const allConfigurations: IPAICluster[] = (await getSingleton(ClusterManager)).allConfigurations;
            this.clusters = allConfigurations.map((config, i) => <IClusterData>({
                type: TreeDataType.Cluster,
                index: i,
                config,
                loadingState: LoadingState.Finished,
                jobs: [],
                shownAmount: settings.get<number>(SETTING_JOB_JOBLIST_ALLJOBSPAGESIZE)!
            }));
            this.onDidChangeTreeDataEmitter.fire();
            if (reload) {
                await this.reloadJobs();
            }
        } else {
            this.onDidChangeTreeDataEmitter.fire(this.clusters[index]);
            if (reload) {
                await this.reloadJobs(index);
            }
        }
    }

    public async eagerLoadRecent(index: number): Promise<void> {
        const filters: ITreeData[] | undefined = await this.getChildren(this.clusters[index]);
        if (filters) {
            this.getChildren(filters[0]);
        }
    }

    public getTreeItem(element: ITreeData): TreeItem {
        switch (element.type) {
            case TreeDataType.Cluster:
                return new ClusterNode(element.config, element.index);
            case TreeDataType.Filter:
                return new FilterNode(element.filterType, element.parent.loadingState);
            case TreeDataType.Job:
                return new JobNode(element.job, element.parent.parent.config);
            case TreeDataType.More:
                return new ShowMoreNode(element.parent.parent);
            default:
                throw new Error('Unexpected node type');
        }
    }

    public async getChildren(element?: ITreeData): Promise<ITreeData[] | undefined> {
        if (!element) {
            // Root nodes: configurations
            return this.clusters;
        }
        switch (element.type) {
            case TreeDataType.Cluster:
            {
                return [
                    { type: TreeDataType.Filter, filterType: FilterType.Recent, parent: element },
                    { type: TreeDataType.Filter, filterType: FilterType.All, parent: element }
                ];
            }
            case TreeDataType.Filter:
                if (element.filterType === FilterType.Recent) {
                    const cluster: IClusterData = element.parent;
                    const settings: WorkspaceConfiguration = workspace.getConfiguration(SETTING_SECTION_JOB);
                    const recentMaxLen: number = settings.get<number>(SETTING_JOB_JOBLIST_RECENTJOBSLENGTH)!;
                    const recentJobs: string[] | undefined = (await getSingleton(RecentJobManager)).allRecentJobs[cluster.index] || [];
                    const result: IJobData[] = [];
                    for (const name of recentJobs.slice(0, recentMaxLen)) {
                        const foundJob: IPAIJobInfo | undefined = cluster.jobs.find(job => job.name === name);
                        if (foundJob) {
                            result.push({
                                type: TreeDataType.Job,
                                job: foundJob,
                                parent: element
                            });
                        }
                    }
                    if (result.length > 0 && result[0].job.name !== cluster.lastLatestJobName) {
                        setImmediate(jobData => this.treeView.reveal(jobData, { focus: true }), result[0]);
                        cluster.lastLatestJobName = result[0].job.name;
                    }

                    return result;
                } else {
                    const cluster: IClusterData = element.parent;
                    const result: (IJobData | IMoreData)[] = cluster.jobs.slice(0, cluster.shownAmount).map(
                        job => <IJobData>({
                            type: TreeDataType.Job,
                            job,
                            parent: element
                        })
                    );
                    if (cluster.lastShownAmount && cluster.lastShownAmount !== cluster.shownAmount) {
                        setImmediate(i => this.treeView.reveal(result[i]), cluster.lastShownAmount - 1);
                        cluster.lastShownAmount = cluster.shownAmount;
                    }
                    if (cluster.jobs.length > cluster.shownAmount) {
                        result.push({ type: TreeDataType.More, parent: element });
                    }
                    return result;
                }
            case TreeDataType.Job:
            case TreeDataType.More:
                return undefined;
            default:
        }
    }

    public getParent(element: ITreeData): ITreeData | undefined {
        return 'parent' in element ? element.parent : undefined;
    }

    public onActivate(): Promise<void> {
        return this.refresh();
    }

    public async onDeactivate(): Promise<void> {
        if (this.refreshTimer) {
            clearTimeout(this.refreshTimer);
        }
        this.treeView.dispose();
    }

    private async reloadJobs(index: number = -1): Promise<void> {
        if (this.refreshTimer) {
            clearTimeout(this.refreshTimer);
        }
        const clusters: IClusterData[] = index !== -1 ? [this.clusters[index]] : this.clusters;
        await Promise.all(clusters.map(async cluster => {
            cluster.loadingState = LoadingState.Loading;
            this.onDidChangeTreeDataEmitter.fire(cluster);
            try {
                cluster.jobs = await request.get(
                    PAIRestUri.jobs(cluster.config),
                    { json: true }
                );
                cluster.loadingState = LoadingState.Finished;
            } catch (e) {
                Util.err('treeview.joblist.error', [e.message || e]);
                cluster.loadingState = LoadingState.Error;
            }
            this.onDidChangeTreeDataEmitter.fire(cluster);
        }));
        const settings: WorkspaceConfiguration = workspace.getConfiguration(SETTING_SECTION_JOB);
        const interval: number = settings.get<number>(SETTING_JOB_JOBLIST_REFERSHINTERVAL)!;
        this.refreshTimer = setTimeout(this.reloadJobs.bind(this), interval * 1000);
    }
}