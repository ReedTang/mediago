import EventEmitter from "events";
import { inject, injectable } from "inversify";
import {
  DownloadParams,
  DownloadProgress,
  DownloadStatus,
  Task,
} from "../interfaces";
import { TYPES } from "../types";
import LoggerServiceImpl from "./LoggerService";
import StoreService from "./StoreService";
import VideoRepository from "../repository/VideoRepository";

@injectable()
export default class DownloadService extends EventEmitter {
  private queue: Task[] = [];

  private active: Task[] = [];

  private limit: number;

  private debug = process.env.APP_DOWNLOAD_DEBUG;

  private signal: Record<number, AbortController> = {};

  constructor(
    @inject(TYPES.LoggerService)
    private readonly logger: LoggerServiceImpl,
    @inject(TYPES.VideoRepository)
    private readonly videoRepository: VideoRepository,
    @inject(TYPES.StoreService)
    private readonly storeService: StoreService,
  ) {
    super();

    const maxRunner = this.storeService.get("maxRunner");
    this.limit = maxRunner;

    this.storeService.onDidChange("maxRunner", (maxRunner) => {
      maxRunner && (this.limit = maxRunner);
    });
  }

  async addTask(task: Task) {
    this.queue.push(task);
    this.runTask();
  }

  async stopTask(id: number) {
    if (this.signal[id]) {
      this.log(`taskId: ${id} stop`);
      this.signal[id].abort();
    }
  }

  async execute(task: Task) {
    try {
      await this.videoRepository.changeVideoStatus(
        task.id,
        DownloadStatus.Downloading,
      );
      this.emit("download-start", task.id);

      this.log(`taskId: ${task.id} start`);
      const controller = new AbortController();
      this.signal[task.id] = controller;

      const callback = (progress: DownloadProgress) => {
        if (progress.type === "progress") {
          this.emit("download-progress", progress);
        } else if (progress.type === "ready") {
          this.emit("download-ready-start", progress);
          if (progress.isLive) {
            this.removeTask(progress.id);
          }
        }
      };

      const params: DownloadParams = {
        ...task.params,
        id: task.id,
        abortSignal: controller,
        callback,
      };

      const { proxy, useProxy } = this.storeService.store;
      if (useProxy) {
        params.proxy = proxy;
      }

      await task.process(params);
      delete this.signal[task.id];
      this.log(`taskId: ${task.id} success`);

      await this.videoRepository.changeVideoStatus(
        task.id,
        DownloadStatus.Success,
      );
      this.emit("download-success", task.id);
    } catch (err: any) {
      this.log(`taskId: ${task.id} failed`);
      if (err.name === "AbortError") {
        // 下载暂停
        await this.videoRepository.changeVideoStatus(
          task.id,
          DownloadStatus.Stopped,
        );
        this.emit("download-stop", task.id);
      } else {
        // 下载失败
        await this.videoRepository.changeVideoStatus(
          task.id,
          DownloadStatus.Failed,
        );
        this.emit("download-failed", task.id, err);
      }
    } finally {
      this.removeTask(task.id);

      // 传输完成
      if (this.queue.length === 0 && this.active.length === 0) {
        // this.emit("download-finish");
      }
    }
  }

  removeTask(id: number) {
    // 处理当前正在活动的任务
    const doneId = this.active.findIndex((i) => i.id === id);
    this.active.splice(doneId, 1);
    // 处理完成的任务
    if (this.active.length < this.limit) {
      this.runTask();
    }
  }

  runTask() {
    while (this.active.length < this.limit && this.queue.length > 0) {
      const task = this.queue.shift();
      if (task) {
        this.active.push(task);
        this.execute(task);
      }
    }
  }

  log(...args: unknown[]) {
    if (this.debug) {
      this.logger.info(`[DownloadService] `, ...args);
    }
  }
}
